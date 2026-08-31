// 공통 설정 로드/저장 — chrome.storage.local 기반, 전 모듈 공유
import {
  STORAGE_KEYS,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_API_STYLE
} from "./constants.js";

// 설정 기본형
export function defaultSettings() {
  return {
    baseUrl: DEFAULT_BASE_URL,      // 예: https://내부망주소 또는 http://localhost:11434/v1
    apiKey: "",
    apiStyle: DEFAULT_API_STYLE,    // "openwebui": /api/chat/completions | "openai": /chat/completions
    defaultModel: DEFAULT_MODEL,
    mockMode: false,                // LLM 없이 저장된 샘플 응답으로 화면 흐름 확인
    imageInput: true                // 내부망 LLM이 이미지 입력을 허용 (사용자 확인됨)
  };
}

// baseUrl 끝의 슬래시 제거 등 정규화
export function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

export async function loadSettings() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  const saved = data[STORAGE_KEYS.SETTINGS] || {};
  const merged = { ...defaultSettings(), ...saved };
  merged.baseUrl = normalizeBaseUrl(merged.baseUrl);
  merged.apiStyle = merged.apiStyle === "openai" ? "openai" : "openwebui";
  merged.defaultModel = String(merged.defaultModel || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  return merged;
}

export async function saveSettings(settings) {
  const merged = { ...defaultSettings(), ...settings };
  merged.baseUrl = normalizeBaseUrl(merged.baseUrl);
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: merged });
  return merged;
}

// 단계별 덮어쓰기(모델·온도 등): promptKey 단위로 저장
export async function loadStepOverrides() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.STEP_OVERRIDES);
  return data[STORAGE_KEYS.STEP_OVERRIDES] || {};
}

export async function saveStepOverride(promptKey, override) {
  const all = await loadStepOverrides();
  if (override && Object.keys(override).length > 0) {
    all[promptKey] = override;
  } else {
    delete all[promptKey];
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.STEP_OVERRIDES]: all });
  return all;
}

// 심사관 저장 교정지시 — 자주 틀리는 출력 형식에 대한 추가 지시를 promptKey별로 누적 [설계 원칙 7]
export async function loadCorrections() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.CORRECTIONS);
  return data[STORAGE_KEYS.CORRECTIONS] || {};
}

export async function saveCorrection(promptKey, text) {
  const all = await loadCorrections();
  const trimmed = String(text || "").trim();
  if (trimmed) {
    all[promptKey] = trimmed;
  } else {
    delete all[promptKey];
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.CORRECTIONS]: all });
  return all;
}
