// TRADEMARK 팝업 — 모듈 런처 + 공통 설정
// 설정은 chrome.storage.local 에 한 번 저장하면 전 모듈이 공유한다. [지시서 2. 기술 구조]

import { MODULES, MESSAGE_TYPES } from "../shared/constants.js";
import { loadSettings, saveSettings, normalizeBaseUrl } from "../shared/settings.js";
import { fetchAvailableModels } from "../shared/llm.js";

const el = (id) => document.getElementById(id);

const gateHint = el("gateHint");
const moduleGrid = el("moduleGrid");
const launchStatus = el("launchStatus");
const settingsSheet = el("settingsSheet");
const settingsStatus = el("settingsStatus");
const modelStatus = el("modelStatus");
const modelInput = el("modelInput");
const modelSelect = el("modelSelect");

const state = {
  settings: null,
  modelOptions: []
};

function setStatus(target, text, tone = "") {
  target.textContent = text;
  target.className = "status" + (tone ? ` ${tone}` : "");
}

function isConfigured() {
  return Boolean(state.settings?.baseUrl) || Boolean(state.settings?.mockMode);
}

// ---------- 설정 시트 ----------

function openSettings() { settingsSheet.classList.remove("hidden"); }
function closeSettings() { settingsSheet.classList.add("hidden"); }

function fillSettingsForm() {
  el("baseUrlInput").value = state.settings.baseUrl;
  el("apiStyleSelect").value = state.settings.apiStyle;
  el("apiKeyInput").value = state.settings.apiKey;
  modelInput.value = state.settings.defaultModel;
  el("mockModeInput").checked = state.settings.mockMode;
  el("imageInputCheck").checked = state.settings.imageInput;
}

function readSettingsForm() {
  const selectedModel = modelSelect.classList.contains("hidden")
    ? modelInput.value
    : modelSelect.value;
  return {
    baseUrl: normalizeBaseUrl(el("baseUrlInput").value),
    apiStyle: el("apiStyleSelect").value,
    apiKey: el("apiKeyInput").value.trim(),
    defaultModel: String(selectedModel || "").trim(),
    mockMode: el("mockModeInput").checked,
    imageInput: el("imageInputCheck").checked
  };
}

async function onSaveSettings() {
  const values = readSettingsForm();
  if (!values.baseUrl && !values.mockMode) {
    setStatus(settingsStatus, "Base URL을 입력하거나 목 모드를 켜 주세요.", "error");
    return;
  }
  if (!values.defaultModel) {
    setStatus(settingsStatus, "기본 모델을 입력해 주세요.", "error");
    return;
  }
  try {
    state.settings = await saveSettings(values);
    setStatus(settingsStatus, "설정을 저장했습니다.", "ok");
    renderModuleCards();
    updateGateHint();
  } catch (error) {
    setStatus(settingsStatus, `저장 실패: ${error.message}`, "error");
  }
}

// 모델 목록 조회 — 저장 전 입력값 기준으로 /api/models (또는 /models) 호출 [개발 순서 1 확인 항목]
async function onLoadModels() {
  const draft = readSettingsForm();
  if (!draft.baseUrl) {
    setStatus(modelStatus, "먼저 Base URL을 입력해 주세요.", "warn");
    return;
  }
  setStatus(modelStatus, "모델 목록을 불러오는 중...");
  el("loadModelsBtn").disabled = true;
  try {
    const models = await fetchAvailableModels({ ...state.settings, ...draft });
    state.modelOptions = models;
    modelSelect.innerHTML = "";
    const current = draft.defaultModel;
    const withCurrent = models.some((m) => m.id === current)
      ? models
      : [{ id: current, label: `${current} (직접 입력)` }, ...models];
    withCurrent.forEach((model) => {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.label;
      if (model.id === current) option.selected = true;
      modelSelect.appendChild(option);
    });
    modelInput.classList.add("hidden");
    modelSelect.classList.remove("hidden");
    setStatus(modelStatus, `모델 ${models.length}개를 불러왔습니다. 목록에서 선택하세요.`, "ok");
  } catch (error) {
    modelInput.classList.remove("hidden");
    modelSelect.classList.add("hidden");
    setStatus(modelStatus, `실패: ${error.message}`, "error");
  } finally {
    el("loadModelsBtn").disabled = false;
  }
}

// ---------- 모듈 런처 ----------

function updateGateHint() {
  if (isConfigured()) {
    gateHint.textContent = "모듈 카드를 눌러 실행하세요.";
    gateHint.className = "gate-hint";
  } else {
    gateHint.textContent = "공통 설정에서 API 주소와 키를 저장하면 모듈을 실행할 수 있습니다.";
    gateHint.className = "gate-hint warn";
  }
}

function renderModuleCards() {
  moduleGrid.innerHTML = "";
  MODULES.forEach((module) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "module-card";
    card.disabled = !module.ready || !isConfigured();

    const head = document.createElement("div");
    head.className = "module-head";
    const title = document.createElement("span");
    title.className = "module-title";
    title.textContent = module.title;
    const chip = document.createElement("span");
    if (module.ready) {
      chip.className = "module-chip";
      chip.textContent = module.launchType === "sidepanel" ? "사이드패널" : "전체 탭";
    } else {
      chip.className = "module-chip pending";
      chip.textContent = module.readyNote || "준비 중";
    }
    head.appendChild(title);
    head.appendChild(chip);

    const desc = document.createElement("p");
    desc.className = "module-desc";
    desc.textContent = module.description;

    card.appendChild(head);
    card.appendChild(desc);
    card.addEventListener("click", () => void launchModule(module));
    moduleGrid.appendChild(card);
  });
}

async function openOrFocusTab(path) {
  const targetUrl = chrome.runtime.getURL(path);
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) =>
    tab.url === targetUrl || String(tab.url || "").startsWith(`${targetUrl}#`)
  );
  if (existing?.id) {
    if (Number.isInteger(existing.windowId)) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    await chrome.tabs.update(existing.id, { active: true });
    return;
  }
  await chrome.tabs.create({ url: targetUrl });
}

async function launchModule(module) {
  try {
    if (module.launchType === "tab") {
      await openOrFocusTab(module.path);
      setStatus(launchStatus, `${module.title}을(를) 열었습니다.`, "ok");
      return;
    }
    // 사이드패널: 사용자 제스처 컨텍스트가 필요하므로 팝업에서 직접 연다.
    // (탭 조건 검증은 사이드패널 자신이 표시) 실패 시 백그라운드 중계로 재시도.
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error("활성 탭을 찾을 수 없습니다.");
    try {
      await chrome.sidePanel.setOptions({ tabId: tab.id, path: module.path, enabled: true });
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch {
      await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.OPEN_SIDE_PANEL, tabId: tab.id, path: module.path });
    }
    setStatus(launchStatus, `${module.title} 사이드패널을 열었습니다.`, "ok");
  } catch (error) {
    setStatus(launchStatus, `${module.title} 실행 실패: ${error.message}`, "error");
  }
}

// ---------- 초기화 ----------

async function initialize() {
  state.settings = await loadSettings();
  fillSettingsForm();
  renderModuleCards();
  updateGateHint();
  if (!isConfigured()) openSettings();
}

el("settingsToggleBtn").addEventListener("click", openSettings);
el("settingsCloseBtn").addEventListener("click", closeSettings);
el("settingsBackdrop").addEventListener("click", closeSettings);
el("saveSettingsBtn").addEventListener("click", () => void onSaveSettings());
el("loadModelsBtn").addEventListener("click", () => void onLoadModels());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSettings();
});

void initialize();
