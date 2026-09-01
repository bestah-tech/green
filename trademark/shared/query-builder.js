// 검색식 조립·검증 (모듈 2 레이어 3) [지시서 5. 모듈 2 / K-QUERY layer_3]
//
// LLM 이 아니라 코드가 담당한다: 승인 대상 용어·변형 목록과 유사군코드를
// config/query_syntax.json 의 연산자 문법으로 조립하고, 길이·항 수 제한을 검증한다.
// 내부망 반입 시 query_syntax.json 만 내부망 문법으로 교체하면 이 코드는 그대로 동작해야 한다.

let syntaxPromise = null;

export async function loadQuerySyntax() {
  if (!syntaxPromise) {
    syntaxPromise = fetch(chrome.runtime.getURL("config/query_syntax.json")).then((r) => r.json());
  }
  return syntaxPromise;
}

// 검색 항(term) 하나를 문법에 맞게 다듬는다: 공백 포함 시 구문 검색("") 처리
function formatTerm(syntax, term) {
  const t = String(term || "").trim();
  if (!t) return "";
  const phrase = syntax.operators?.phrase || "";
  if (/\s/.test(t) && phrase.length >= 2) {
    const open = phrase[0];
    const close = phrase[phrase.length - 1];
    return `${open}${t}${close}`;
  }
  return t;
}

// 필드 접미사 적용: "선라이즈" + markName → "선라이즈.TN" (필드 정의가 없으면 그대로)
function applyField(syntax, expr, fieldKey) {
  const suffix = syntax.fields?.[fieldKey];
  return suffix ? `${expr}.${suffix}` : expr;
}

// OR 묶음 조립: ["a","b"] → "(a+b)" (1개면 괄호 생략)
function orGroup(syntax, terms) {
  const or = syntax.operators?.or || "+";
  const formatted = [...new Set(terms.map((t) => formatTerm(syntax, t)).filter(Boolean))];
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
// 반환: [{ label, query, purpose, valid, issues }]
export function buildQueries(syntax, { terms = [], variations = [], similarGroupCodes = [] } = {}) {
  const and = syntax.operators?.and || "*";
  const queries = [];

  const included = variations.filter((v) => v.include !== false);
  const variantsOf = (base) =>
    included.filter((v) => v.base === base).map((v) => v.variant);

  // ① core 용어별 그룹 검색식: 용어 + 그 변형을 OR 로 묶어 표장명 검색
  const coreTerms = terms.filter((t) => t.priority === "core");
  coreTerms.forEach((t) => {
    const group = orGroup(syntax, [t.term, ...variantsOf(t.term)]);
    if (!group) return;
    const query = applyField(syntax, group, "markName");
    queries.push({
      label: `핵심 — ${t.term} (${t.kind})`,
      query,
      purpose: "core-term",
      ...validateQuery(syntax, query)
    });
  });

  // ② support 용어 그룹 검색식 (있을 때만)
  terms.filter((t) => t.priority === "support").forEach((t) => {
    const group = orGroup(syntax, [t.term, ...variantsOf(t.term)]);
    if (!group) return;
    const query = applyField(syntax, group, "markName");
    queries.push({
      label: `보조 — ${t.term} (${t.kind})`,
      query,
      purpose: "support-term",
      ...validateQuery(syntax, query)
    });
  });

  // ③ 결합 검색식: 모든 용어·변형 OR ∧ 유사군코드 OR — 상품 범위를 좁힌 정밀 검색
  const allTerms = terms.flatMap((t) => [t.term, ...variantsOf(t.term)]);
  const codes = [...new Set(similarGroupCodes.filter((c) => c && c !== "unknown"))];
  if (allTerms.length > 0 && codes.length > 0) {
    const termGroup = orGroup(syntax, allTerms);
    const codeGroup = applyField(syntax, orGroup(syntax, codes), "similarGroupCode");
    const query = `${applyField(syntax, termGroup, "markName")}${and}${codeGroup}`;
    queries.push({
      label: "결합 — 전체 용어 × 유사군코드",
      query,
      purpose: "combined",
      ...validateQuery(syntax, query)
    });
  }

  return queries;
}
