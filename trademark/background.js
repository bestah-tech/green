// TRADEMARK 백그라운드 서비스 워커
// 구버전 크롬 호환을 위해 import 없이 단독 파일로 작성한다.
// 1단계에서는 사이드패널 열기만 담당한다.
// (검색 에이전트의 content script ↔ LLM 중계는 5단계에서 추가)

var TM_OPEN_SIDE_PANEL = "TM_OPEN_SIDE_PANEL"; // shared/constants.js 의 MESSAGE_TYPES.OPEN_SIDE_PANEL 과 동일한 값

chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
  if (message && message.type === TM_OPEN_SIDE_PANEL) {
    Promise.resolve()
      .then(function () {
        return chrome.sidePanel.setOptions({
          tabId: message.tabId,
          path: message.path || "sidepanel/sidepanel.html",
          enabled: true
        });
      })
      .then(function () {
        return chrome.sidePanel.open({ tabId: message.tabId });
      })
      .then(function () {
        sendResponse({ ok: true });
      })
      .catch(function (error) {
        sendResponse({ ok: false, error: (error && error.message) || String(error) });
      });
    return true; // 비동기 응답
  }
  return false;
});
