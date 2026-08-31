// TRADEMARK 백그라운드 서비스 워커
// 1단계에서는 사이드패널 열기만 담당한다.
// (검색 에이전트의 content script ↔ LLM 중계는 5단계에서 추가)

import { MESSAGE_TYPES } from "./shared/constants.js";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === MESSAGE_TYPES.OPEN_SIDE_PANEL) {
    (async () => {
      try {
        await chrome.sidePanel.setOptions({
          tabId: message.tabId,
          path: message.path || "sidepanel/sidepanel.html",
          enabled: true
        });
        await chrome.sidePanel.open({ tabId: message.tabId });
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();
    return true; // 비동기 응답
  }
  return false;
});
