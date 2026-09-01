// 검색식 조립·검증 (모듈 2 레이어 3) [지시서 5. 모듈 2 / K-QUERY layer_3]
//
// LLM 이 아니라 코드가 담당한다: 승인 대상 용어·변형 목록을
// config/query_syntax.json 의 내부망 문법(kiponet3-ts)으로 조립하고 검증한다.
// 내부망 문법 실측 (심사점검표 HTML 의 실제 검색 URL 예시):
//   TmName=오성+오승 / (자몽+jamong)&(나라+nara) / /CURO+/쿠로 / w?n/
//   → or "+", and "&", wildcard "?"(1자), anchor "/"(칭호 경계)
// 유사군코드는 검색식이 아니라 별도 파라미터 ClassCd (+ 로 연결) 로 전달된다.

let syntaxPromise = null;

export async function loadQuerySyntax() {
  if (!syntaxPromise) {
    syntaxPromise = fetch(chrome.runtime.getURL("config/query_syntax.json")).then((r) => r.json());
  }
  return syntaxPromise;
}

// OR 묶음 조립: ["a","b"] → "(a+b)" (1개면 괄호 생략, 중복 제거)
function orGroup(syntax, terms) {
  const or = syntax.operators?.or || "+";
  const formatted = [...new Set(terms.map((t) => String(t || "").trim()).filter(Boolean))];
  if (formatted.length === 0) return "";
  if (formatted.length === 1) return formatted[0];
  return `(${formatted.join(or)})`;
}

// 검색식 1건 검증 — 반환: { valid, issues: [] }
export function validateQuery(syntax, query) {
  const issues = [];
  const limits = syntax.limits || {};
  if (!query || !query.trim()) {
    issues.push("검색식이 비어 있습니다.");
  }
  if (limits.maxQueryLength && query.length > limits.maxQueryLength) {
    issues.push(`길이 ${query.length}자 — 최대 ${limits.maxQueryLength}자를 초과합니다. 나눠서 검색하세요.`);
  }
  const or = syntax.operators?.or || "+";
  // OR 항 수: or 연산자 등장 횟수 + 1 (괄호 중첩까지 정확히 세지 않는 근사치)
  const orCount = query.split(or).length;
  if (limits.maxOrTerms && orCount > limits.maxOrTerms) {
    issues.push(`OR 항 ${orCount}개 — 최대 ${limits.maxOrTerms}개를 초과합니다. 그룹을 나누세요.`);
  }
  // 괄호 짝 검사
  let depth = 0;
  for (const ch of query) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (depth < 0) break;
  }
  if (depth !== 0) issues.push("괄호 짝이 맞지 않습니다.");
  return { valid: issues.length === 0, issues };
}

// 검색식 목록 조립
// terms:      [{ term, kind, priority }]           — 심사관이 확정한 용어 (kind: 표기|칭호|관념)
// variations: [{ base, variant, type, include }]   — include 가 true 인 변형만 사용
// similarGroupCodes: ["G1201", ...]                — 승인 1 지정상품의 유사군코드 (unknown 제외)
// 반환: [{ label, query(TmName 검색식), classCd(ClassCd 값, + 연결), purpose, valid, issues }]
export function buildQueries(syntax, { terms = [], variations = [], similarGroupCodes = [] } = {}) {
  const or = syntax.operators?.or || "+";
  const queries = [];

  const included = variations.filter((v) => v.include !== false);
  const variantsOf = (base) =>
    included.filter((v) => v.base === base).map((v) => v.variant);

  const codes = [...new Set(similarGroupCodes.filter((c) => c && c !== "unknown"))];
  const classCd = codes.join(or); // ClassCd 파라미터 값 — 검색식과 별개로 상품 범위를 제한

  const pushGroup = (t, labelPrefix, purpose) => {
    const query = orGroup(syntax, [t.term, ...variantsOf(t.term)]);
    if (!query) return;
    queries.push({
      label: `${labelPrefix} — ${t.term} (${t.kind})`,
      query,
      classCd,
      purpose,
      ...validateQuery(syntax, query)
    });
  };

  // ① core 용어별 그룹 검색식: 용어 + 그 변형을 OR 로 묶는다
  terms.filter((t) => t.priority === "core").forEach((t) => pushGroup(t, "핵심", "core-term"));

  // ② support 용어 그룹 검색식
  terms.filter((t) => t.priority === "support").forEach((t) => pushGroup(t, "보조", "support-term"));

  // ③ 결합 검색식: 모든 용어·변형을 한 번에 OR — 넓게 한 번 훑는 용도
  const allTerms = terms.flatMap((t) => [t.term, ...variantsOf(t.term)]);
  if (allTerms.length > 1) {
    const query = orGroup(syntax, allTerms);
    queries.push({
      label: "결합 — 전체 용어",
      query,
      classCd,
      purpose: "combined",
      ...validateQuery(syntax, query)
    });
  }

  return queries;
}

// 검색 URL 조립 — 크롬에서 검색시스템이 열리면 이 URL 로 바로 검색 실행 가능.
// kind: "similar"(유사질의어) | "query"(질의어) | "aiName"(AI 호칭)
export function buildSearchUrl(syntax, { kind = "similar", tmName, classCd = "", applNo = "" } = {}) {
  const urls = syntax.searchUrls || {};
  const path = urls[kind] || urls.similar;
  if (!path || !tmName) return "";
  const base = (urls.base || "").replace(/\/+$/, "");
  const params = syntax.params || {};
  const parts = [
    `${params.markName || "TmName"}=${encodeURIComponent(tmName)}`,
    `${params.similarGroupCode || "ClassCd"}=${encodeURIComponent(classCd)}`,
    `${params.applicationNumber || "ApplNo"}=${encodeURIComponent(String(applNo).replace(/-/g, ""))}`
  ];
  const sep = path.includes("?") ? "&" : "?";
  return `${base}${path}${sep}${parts.join("&")}`;
}
