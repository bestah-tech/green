// 33조 코퍼스 처리 [SPEC §1-2, §6-1]
// 원문모음 txt 파싱(표기 흔들림 처리) · 정규화 · 후보 검색 · 코퍼스 충실성(fidelity) 검사.
// 코퍼스 데이터는 저장소에 포함하지 않고, 심사관이 파일로 불러와 브라우저(IndexedDB)에만 저장한다.

// ---------- 정규화 [SPEC §1-2] ----------
// 따옴표·중점 혼용, 다중 공백을 통일한다. 파싱·대조 모두 이 함수를 거친다.
export function normalizeText(text) {
  return String(text || "")
    .replace(/[“”]/g, '"')   // “ ” → "
    .replace(/[‘’]/g, "'")   // ‘ ’ → '
    .replace(/[ㆍ․·]/g, "・") // ㆍ ․ · → ・(통일)
    .replace(/[ \t]+/g, " ")
    .replace(/ +$/gm, "")
    .trim();
}

// ---------- 원문모음 파싱 ----------
// 헤더는 선택적이므로 마무리(○ 지정상품/거절 대상…) 기준으로 레코드를 닫는다.
// 마무리조차 없는 꼬리 레코드는 헤더 출현으로 구분해 살린다. (실측: 헤더 234, 마무리 216)
const HEADER_RE = /^\s*\[\s*거절이유\s*\d*\s*\]\s*(.*)$/;
const CLOSING_RE = /^\s*○\s*(지정상품|거절\s*대상이\s*되는\s*상품)\s*[:：]?.*$/;

export function parseCorpusText(rawText) {
  const lines = normalizeText(rawText).replace(/\r\n/g, "\n").split("\n");
  const records = [];
  let current = { header: "", bodyLines: [], closing: "" };

  const flush = () => {
    const body = current.bodyLines.join("\n").trim();
    if (body || current.header) {
      records.push({
        id: records.length + 1,
        header: current.header,
        grounds: extractGrounds(current.header || body),
        body,
        closing: current.closing
      });
    }
    current = { header: "", bodyLines: [], closing: "" };
  };

  lines.forEach((line) => {
    if (HEADER_RE.test(line)) {
      // 새 헤더가 나오면 (마무리 없이 끝난) 직전 레코드를 닫는다
      if (current.header || current.bodyLines.some((l) => l.trim())) flush();
      current.header = line.trim();
      return;
    }
    if (CLOSING_RE.test(line)) {
      current.closing = line.trim();
      flush();
      return;
    }
    current.bodyLines.push(line);
  });
  if (current.header || current.bodyLines.some((l) => l.trim())) flush();
  return records.filter((r) => r.body.length > 30); // 조각·빈 레코드 제거
}

// 헤더/본문에서 적용 호 추출: "제3호 및 제7호", "제3호/제6호/제7호" 등
export function extractGrounds(text) {
  const matches = String(text || "").match(/제\s*(\d)\s*호/g) || [];
  return [...new Set(matches.map((m) => Number(m.replace(/[^\d]/g, ""))))].sort((a, b) => a - b);
}

// ---------- 후보 검색 (top-k, 넓게) [SPEC corpus/retrieve] ----------
// 최종 선택은 LLM(앵커 단계)이 하므로 여기서는 조항 일치 + 키워드 겹침으로 넓게 고른다.

function tokenize(text) {
  return normalizeText(text).split(/[\s"'()[\]{},.:;・~〜!?]+/).filter((t) => t.length >= 2);
}

export function retrieveCandidates(records, analysis, k = 10) {
  const targetGrounds = [...analysis.ground.grounds].sort((a, b) => a - b);
  const keywords = new Set(tokenize([
    analysis.overall_concept,
    (analysis.quality_types || []).join(" "),
    ...(analysis.components || []).map((c) => `${c.meaning || ""} ${c.role} ${c.script}`)
  ].join(" ")));

  const scored = records.map((record) => {
    let score = 0;
    const rg = record.grounds.join(",");
    if (rg === targetGrounds.join(",")) score += 6;          // 조항 조합 완전 일치
    else score += record.grounds.filter((g) => targetGrounds.includes(g)).length;
    const bodyTokens = new Set(tokenize(record.body));
    keywords.forEach((kw) => { if (bodyTokens.has(kw)) score += 1; });
    return { record, score };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, k).map((s) => s.record);
}

// ---------- 코퍼스 충실성 검사 [SPEC §6-1] ----------
// 초안에서 사안 고유 내용을 마스킹한 뒤, 남은 골격 어절 n-gram 이 코퍼스에 있는지 대조한다.
// 차단기가 아니라 [검토 필요] 피드백이다.

const NGRAM_N = 6;

function wordNgrams(tokens, n) {
  const grams = [];
  for (let i = 0; i + n <= tokens.length; i += 1) {
    grams.push(tokens.slice(i, i + n).join(" "));
  }
  return grams;
}

let ngramCache = { key: "", set: null };

export function buildCorpusNgrams(records) {
  const key = `${records.length}:${records[0]?.body?.length || 0}`;
  if (ngramCache.key === key && ngramCache.set) return ngramCache.set;
  const set = new Set();
  records.forEach((record) => {
    const tokens = tokenize(record.body);
    wordNgrams(tokens, NGRAM_N).forEach((gram) => set.add(gram));
  });
  ngramCache = { key, set };
  return set;
}

// 사안 고유 내용(표장·구성·의미·관념·상품명)을 ◇ 로 치환해 골격만 남긴다
function maskCaseSpecific(draft, analysis, goodsText) {
  let masked = normalizeText(draft);
  const specifics = [
    ...(analysis.components || []).flatMap((c) => [c.text, c.meaning, c.source_word]),
    analysis.overall_concept,
    ...(analysis.quality_types || []),
    ...tokenize(goodsText || "")
  ].filter((s) => s && String(s).length >= 2)
    .sort((a, b) => String(b).length - String(a).length);
  specifics.forEach((term) => {
    masked = masked.split(normalizeText(String(term))).join(" ◇ ");
  });
  return masked;
}

export function fidelityReport(draft, analysis, goodsText, corpusNgrams) {
  const masked = maskCaseSpecific(draft, analysis, goodsText);
  const tokens = tokenize(masked).filter((t) => t !== "◇");
  const grams = wordNgrams(tokens, NGRAM_N);
  if (grams.length === 0) return { unmatched: [], ratio: 0 };

  const unmatchedGrams = grams.filter((gram) => !corpusNgrams.has(gram));
  // 연속으로 미매칭인 구간을 구절 단위로 합친다
  const phrases = [];
  let bucket = [];
  grams.forEach((gram) => {
    if (corpusNgrams.has(gram)) {
      if (bucket.length) { phrases.push(bucket); bucket = []; }
    } else {
      bucket.push(gram);
    }
  });
  if (bucket.length) phrases.push(bucket);
  const phraseTexts = phrases.map((group) => {
    const first = group[0].split(" ");
    const rest = group.slice(1).map((g) => g.split(" ").pop());
    return [...first, ...rest].join(" ");
  });
  return {
    unmatched: phraseTexts.slice(0, 5),
    ratio: Math.round((unmatchedGrams.length / grams.length) * 100) / 100
  };
}
