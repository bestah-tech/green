// TRADEMARK 공통 상수
// 모든 모듈이 공유하는 저장 키·기본값·모듈 정의를 한 곳에 모은다.

// LLM 기본값 — 내부망 OpenWebUI 기준. 외부망 개발 시 Ollama(http://localhost:11434/v1, apiStyle "openai")로 전환.
// 내부망 LLM 주소는 K-SUITE와 동일하게 고정 (환경이 다르면 설정에서 수정 가능).
export const DEFAULT_BASE_URL = "https://llm.moip.go.kr";
export const DEFAULT_MODEL = "gemma4-26b-moe";
export const DEFAULT_API_STYLE = "openwebui"; // "openwebui" | "openai"
export const LLM_REQUEST_TIMEOUT_MS = 180000;
export const MODEL_LIST_TIMEOUT_MS = 30000;

// chrome.storage.local 키 (공통 설정)
export const STORAGE_KEYS = Object.freeze({
  SETTINGS: "tmSettingsV1",           // { baseUrl, apiKey, apiStyle, defaultModel, mockMode, imageInput }
  STEP_OVERRIDES: "tmStepOverridesV1", // 단계별 모델·파라미터 덮어쓰기 { [promptKey]: { model, temperature, maxTokens } }
  CORRECTIONS: "tmCorrectionsV1",      // 심사관 저장 교정지시 { [promptKey]: "누적 텍스트" }
  ACTIVE_CASE_ID: "tmActiveCaseIdV1"   // 현재 작업 중인 출원건
});

// 확장 내부 메시지 타입
export const MESSAGE_TYPES = Object.freeze({
  OPEN_SIDE_PANEL: "TM_OPEN_SIDE_PANEL",
  LLM_REQUEST: "TM_LLM_REQUEST"
});

// 모듈 정의 — 팝업 런처가 이 목록으로 카드를 그린다.
// ready: false 모듈은 "준비 중"으로 표시 (개발 순서에 따라 단계별 활성화)
export const MODULES = Object.freeze([
  {
    id: "dashboard",
    title: "통합 대시보드",
    description: "모듈 1·2 — 출원상표 분석(표장 구성·지정상품·외국어 의미)과 검색식 작성.",
    launchType: "tab",
    path: "dashboard/dashboard.html",
    ready: true
  },
  {
    id: "search-agent",
    title: "검색 에이전트",
    description: "모듈 3 — 검색시스템 탭 사이드패널에서 검색결과 수집·후보 저장·유사도 평가.",
    launchType: "sidepanel",
    path: "sidepanel/sidepanel.html",
    ready: true
  },
  {
    id: "review",
    title: "유사판단 리뷰",
    description: "모듈 4 — 칭호·외관·관념 3요소 대비표와 지정상품 유사군 대비표.",
    launchType: "tab",
    path: "dashboard/dashboard.html#review",
    ready: false,
    readyNote: "6단계에서 구현 예정"
  },
  {
    id: "notice",
    title: "통지서 작성",
    description: "모듈 5 — 문구 자산 기반 의견제출통지서·거절결정서 초안 작성과 HWPX 출력.",
    launchType: "tab",
    path: "dashboard/dashboard.html#notice",
    ready: true
  }
]);

// LLM 호출 공통 금지사항 — 모든 시스템 프롬프트에 삽입된다. [설계 원칙 2·6·9]
export const COMMON_PROHIBITIONS = [
  "판례 번호·심결례 번호·사건번호를 절대 생성하지 마라. 등록된 문구 자산에 있는 것만 인용할 수 있다.",
  "확인할 수 없는 항목은 그럴듯하게 채우지 말고 반드시 \"unknown\"으로 남겨라.",
  "심사 결론을 단정하는 문장(예: \"거절함이 타당하다\")을 먼저 쓰지 마라. 판단은 심사관이 내린다.",
  "지정된 JSON 스키마 외의 텍스트·설명·코드블록 표시를 출력하지 마라. JSON 하나만 출력한다."
];
