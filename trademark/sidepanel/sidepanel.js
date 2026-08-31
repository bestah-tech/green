// 사이드패널 자리표시 (모듈 3은 5단계에서 구현)
// 현재 탭이 검색시스템 탭인지 여부만 확인해 보여준다.

async function showTabInfo() {
  const info = document.getElementById("tabInfo");
  try {
    // selectors.json 의 urlPatterns 로 탭 조건을 검사한다 (내부망 반입 시 파일만 교체)
    const response = await fetch(chrome.runtime.getURL("config/selectors.json"));
    const selectors = await response.json();
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const url = String(tab?.url || "");
    const matched = (selectors.urlPatterns || []).some((pattern) => url.includes(pattern));
    info.textContent = matched
      ? `현재 탭: 검색시스템 탭 조건 충족 (${url})`
      : `현재 탭: 탭 조건 미충족 (${url || "URL 없음"})`;
  } catch (error) {
    info.textContent = `탭 정보를 읽을 수 없습니다: ${error.message}`;
  }
}

void showTabInfo();
