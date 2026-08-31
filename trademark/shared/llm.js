// LLM 호출 공통 래퍼 [지시서 6. LLM 호출 규약]
//
// - baseUrl·apiKey·model·temperature·maxTokens·교정지시를 받아 호출
// - apiStyle 전환: "openwebui" → {base}/api/chat/completions, {base}/api/models
//                  "openai"   → {base}/chat/completions,     {base}/models   (Ollama는 baseUrl에 /v1 포함)
// - 시스템 프롬프트 구조: [역할] + [출력 JSON 스키마] + [공통 금지사항] + [심사관 저장 교정지시]
// - 응답 처리: 코드블록 제거 → JSON 파싱 → 스키마 검증 → 실패 시 오류 포함 1회 재요청 → 그래도 실패면 원문 포함 오류
// - 목 모드: LLM 없이 저장된 샘플 응답 반환
// - 긴 입력 청크 분할 헬퍼 chunkArray 제공 (호출부에서 병합)

import { COMMON_PROHIBITIONS, LLM_REQUEST_TIMEOUT_MS, MODEL_LIST_TIMEOUT_MS } from "./constants.js";
import { loadSettings, loadStepOverrides, loadCorrections } from "./settings.js";
import { validateSchema } from "./schema-validator.js";
import { getMockResponse } from "./db.js";

// ---------- 엔드포인트 결정 ----------

export function resolveChatUrl(settings) {
  const base = settings.baseUrl;
  if (!base) throw new Error("API Base URL이 설정되지 않았습니다. 팝업의 공통 설정에서 저장해 주세요.");
  return settings.apiStyle === "openai"
    ? `${base}/chat/completions`
    : `${base}/api/chat/completions`;
}

export function resolveModelsUrl(settings) {
  const base = settings.baseUrl;
  if (!base) throw new Error("API Base URL이 설정되지 않았습니다. 팝업의 공통 설정에서 저장해 주세요.");
  return settings.apiStyle === "openai"
    ? `${base}/models`
    : `${base}/api/models`;
}

// ---------- HTTP 공통 ----------

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`요청 시간 초과 (${Math.round(timeoutMs / 1000)}초): ${url}`);
    }
    throw new Error(`네트워크 오류: ${error?.message || error} (${url})`);
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders(settings) {
  const headers = { "Content-Type": "application/json" };
  if (settings.apiKey) headers["Authorization"] = `Bearer ${settings.apiKey}`;
  return headers;
}

// ---------- 모델 목록 조회 ----------

// 반환: [{ id, label }]
export async function fetchAvailableModels(overrideSettings = null) {
  const settings = overrideSettings || (await loadSettings());
  if (settings.mockMode) {
    return [{ id: settings.defaultModel, label: `${settings.defaultModel} (목 모드)` }];
  }
  const response = await fetchWithTimeout(
    resolveModelsUrl(settings),
    { method: "GET", headers: authHeaders(settings) },
    MODEL_LIST_TIMEOUT_MS
  );
  if (!response.ok) {
    throw new Error(`모델 목록 조회 실패: HTTP ${response.status} ${response.statusText}`);
  }
  const body = await response.json();
  // OpenWebUI·OpenAI·Ollama 모두 { data: [...] } 형태. 방어적으로 배열 루트도 허용.
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  const models = list
    .map((item) => ({
      id: String(item?.id || item?.name || "").trim(),
      label: String(item?.name || item?.id || "").trim()
    }))
    .filter((item) => item.id);
  if (models.length === 0) throw new Error("모델 목록이 비어 있습니다. Base URL과 API 방식(apiStyle)을 확인해 주세요.");
  return models;
}

// ---------- 채팅 호출 (텍스트 반환) ----------

// messages: [{ role, content }] — content 는 문자열 또는 멀티모달 배열
//   이미지 입력: { role: "user", content: [{ type: "text", text }, { type: "image_url", image_url: { url: "data:image/..." } }] }
export async function chat({ messages, model, temperature, maxTokens, settings: overrideSettings } = {}) {
  const settings = overrideSettings || (await loadSettings());
  const payload = {
    model: String(model || settings.defaultModel).trim(),
    messages,
    stream: false
  };
  if (temperature !== undefined && temperature !== null && temperature !== "") {
    payload.temperature = Number(temperature);
  }
  if (maxTokens) payload.max_tokens = Number(maxTokens);

  const response = await fetchWithTimeout(
    resolveChatUrl(settings),
    { method: "POST", headers: authHeaders(settings), body: JSON.stringify(payload) },
    LLM_REQUEST_TIMEOUT_MS
  );
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 300);
    } catch { /* 본문 없음 */ }
    throw new Error(`LLM 호출 실패: HTTP ${response.status} ${detail}`);
  }
  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("LLM 응답에 message.content 가 없습니다.");
  return content;
}

// ---------- JSON 구조화 호출 [설계 원칙 1·7] ----------

// 코드블록(```json ... ```) 제거 후 JSON 부분만 추출
export function stripToJson(text) {
  let cleaned = String(text || "").trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) cleaned = fence[1].trim();
  // 앞뒤 잡담 제거: 첫 { 또는 [ 부터 마지막 } 또는 ] 까지
  const start = Math.min(
    ...["{", "["].map((ch) => {
      const idx = cleaned.indexOf(ch);
      return idx === -1 ? Infinity : idx;
    })
  );
  const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
  if (start !== Infinity && end > start) cleaned = cleaned.slice(start, end + 1);
  return cleaned;
}

// 시스템 프롬프트 조립: [역할] + [스키마] + [금지사항] + [교정지시]
function buildSystemPrompt({ role, schema, extraRules, corrections, runNote }) {
  const parts = [];
  parts.push(String(role || "").trim());
  if (schema) {
    parts.push(
      "## 출력 형식\n다음 JSON 스키마를 만족하는 JSON 하나만 출력하라. 다른 텍스트를 붙이지 마라.\n" +
      "```json\n" + JSON.stringify(schema, null, 2) + "\n```"
    );
  }
  const rules = [...COMMON_PROHIBITIONS, ...(extraRules || [])];
  parts.push("## 금지사항\n" + rules.map((r) => `- ${r}`).join("\n"));
  if (corrections) {
    parts.push("## 심사관 교정지시 (반드시 준수)\n" + corrections);
  }
  if (runNote) {
    parts.push("## 이번 실행에만 적용할 요청사항\n" + String(runNote).trim());
  }
  return parts.filter(Boolean).join("\n\n");
}

// 구조화 JSON 호출 본체
// promptKey: 단계 식별자 (교정지시·단계별 덮어쓰기·목 응답 키)
// role: 역할 프롬프트, schema: 출력 스키마, userContent: 문자열 또는 멀티모달 배열
// runNote: "이번 실행에만 적용" 일회성 지시
// 반환: { ok, data, raw, errors, retried }
export async function callJson({
  promptKey,
  role,
  schema,
  userContent,
  extraRules,
  runNote,
  model,
  temperature,
  maxTokens
}) {
  const settings = await loadSettings();

  // 목 모드: IndexedDB에 저장된 샘플 응답을 그대로 사용
  if (settings.mockMode) {
    const mock = await getMockResponse(promptKey);
    if (mock === null) {
      return { ok: false, data: null, raw: "", retried: false, errors: [`목 모드: "${promptKey}" 샘플 응답이 등록되어 있지 않습니다.`] };
    }
    const check = schema ? validateSchema(mock, schema) : { ok: true, errors: [] };
    return { ok: check.ok, data: mock, raw: JSON.stringify(mock), retried: false, errors: check.errors };
  }

  const [overrides, corrections] = await Promise.all([loadStepOverrides(), loadCorrections()]);
  const stepOverride = overrides[promptKey] || {};
  const effective = {
    model: model || stepOverride.model || settings.defaultModel,
    temperature: temperature ?? stepOverride.temperature,
    maxTokens: maxTokens || stepOverride.maxTokens
  };

  const systemPrompt = buildSystemPrompt({
    role,
    schema,
    extraRules,
    corrections: corrections[promptKey] || "",
    runNote
  });

  const baseMessages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent }
  ];

  // 1차 시도 → 파싱·검증 실패 시 오류 메시지를 포함해 1회 재요청 [규약]
  let raw = "";
  let lastErrors = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const messages = attempt === 0
      ? baseMessages
      : [
          ...baseMessages,
          { role: "assistant", content: raw },
          {
            role: "user",
            content:
              "직전 응답이 형식 검증에 실패했다. 오류를 고쳐 스키마에 맞는 JSON 하나만 다시 출력하라.\n오류:\n" +
              lastErrors.map((e) => `- ${e}`).join("\n")
          }
        ];

    raw = await chat({ messages, ...effective, settings });

    let parsed;
    try {
      parsed = JSON.parse(stripToJson(raw));
    } catch (error) {
      lastErrors = [`JSON 파싱 실패: ${error.message}`];
      continue;
    }

    const check = schema ? validateSchema(parsed, schema) : { ok: true, errors: [] };
    if (check.ok) {
      return { ok: true, data: parsed, raw, retried: attempt > 0, errors: [] };
    }
    lastErrors = check.errors;
  }

  // 재시도까지 실패: 사용자에게 원문을 보여줄 수 있게 raw 포함 [규약]
  return { ok: false, data: null, raw, retried: true, errors: lastErrors };
}

// ---------- 긴 입력 청크 분할 ----------

// 지정상품 수백 개 등 긴 배열을 나눠 호출하고 코드에서 병합할 때 사용
export function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// 이미지 입력용 멀티모달 content 헬퍼 (OpenAI vision 형식)
export function buildImageContent(text, dataUrls = []) {
  return [
    { type: "text", text },
    ...dataUrls.map((url) => ({ type: "image_url", image_url: { url } }))
  ];
}
