// 지정상품 → 유사군코드 매칭 (LLM 미사용, 기준표 코드 매칭) [지시서 모듈 1]
// 매칭 실패는 "unknown" 으로 남기고 심사관이 직접 입력한다. [설계 원칙 6]

let tablePromise = null;

// data/similar_group_codes.json 로드 (1회 캐시)
export async function loadSimilarGroupTable() {
  if (!tablePromise) {
    tablePromise = (async () => {
      const response = await fetch(chrome.runtime.getURL("data/similar_group_codes.json"));
      if (!response.ok) throw new Error("similar_group_codes.json 을 읽을 수 없습니다.");
      const body = await response.json();
      return Array.isArray(body?.entries) ? body.entries : [];
    })();
  }
  return tablePromise;
}

// 비교용 정규화: 공백·괄호 안 부연 제거
function normalizeName(name) {
  return String(name || "")
    .replace(/\(.*?\)/g, "")
    .replace(/\s+/g, "")
    .trim();
}

// 상품명(+류)으로 유사군코드 찾기. 실패 시 "unknown".
export function matchSimilarGroupCode(entries, name, klass) {
  const target = normalizeName(name);
  if (!target) return "unknown";
  const classNum = Number(klass);

  // 1순위: 이름+류 모두 일치, 2순위: 이름만 일치
  let fallback = null;
  for (const entry of entries) {
    if (normalizeName(entry.name) !== target) continue;
    if (Number.isFinite(classNum) && Number(entry.class) === classNum) return entry.code;
    if (!fallback) fallback = entry.code;
  }
  return fallback || "unknown";
}
