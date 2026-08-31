// 모듈 3 — 선행상표 후보 유사도 평가 프롬프트·스키마
// 칭호·외관(텍스트 기준)·관념 각각 0~100 점수 + 근거 문장. [지시서 모듈 3]
// 지정상품 유사군 비교는 LLM이 아니라 코드가 담당한다.

export const CANDIDATE_SCORE = {
  promptKey: "candidate_score",
  role: [
    "너는 대한민국 상표심사관을 보조하는 유사도 평가 도구다.",
    "출원상표와 선행상표 후보를 칭호(발음)·외관(문자 구성, 텍스트 기준)·관념(의미) 세 요소로 비교해 각각 0~100 점수를 매긴다.",
    "점수 기준: 0~20 비유사, 21~50 낮은 유사, 51~75 상당한 유사, 76~100 높은 유사.",
    "각 요소마다 점수의 근거 문장을 1~2개 적는다. 근거는 두 표장의 실제 구성 비교만 사용한다.",
    "이 점수는 심사관의 검토 우선순위를 정하는 보조 지표일 뿐이며, 유사 여부의 결론이 아니다."
  ].join("\n"),
  schema: {
    type: "object",
    required: ["pronunciation", "appearance", "concept", "summary"],
    properties: {
      pronunciation: {
        type: "object",
        required: ["score", "reasons"],
        properties: {
          score: { type: "integer" },
          reasons: { type: "array", items: { type: "string" }, minItems: 1 }
        }
      },
      appearance: {
        type: "object",
        required: ["score", "reasons"],
        properties: {
          score: { type: "integer" },
          reasons: { type: "array", items: { type: "string" }, minItems: 1 }
        }
      },
      concept: {
        type: "object",
        required: ["score", "reasons"],
        properties: {
          score: { type: "integer" },
          reasons: { type: "array", items: { type: "string" }, minItems: 1 }
        }
      },
      summary: { type: "string" }
    }
  }
};

// 목 모드 샘플 (LLM 없이 화면 흐름 확인용)
export const SCORE_MOCK = {
  pronunciation: { score: 78, reasons: ["두 표장 모두 '선라이즈'로 호칭되어 칭호가 사실상 동일하다. (목 모드 샘플)"] },
  appearance: { score: 55, reasons: ["영문 철자 구성이 일부 겹치나 글자 수·배열에 차이가 있다. (목 모드 샘플)"] },
  concept: { score: 70, reasons: ["양 표장 모두 '해돋이' 관념을 전달한다. (목 모드 샘플)"] },
  summary: "목 모드 샘플 평가입니다. 실제 LLM 평가가 아닙니다."
};
