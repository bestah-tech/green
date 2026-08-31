// 모듈 1 — 출원상표 분석 LLM 프롬프트·스키마 정의
// LLM은 구조화 JSON만 생성하고, 유사군코드 매칭·문서 조립은 코드가 한다. [설계 원칙 1]

// ① 표장 구성 분석
export const MARK_STRUCTURE = {
  promptKey: "mark_structure",
  role: [
    "너는 대한민국 상표심사관을 보조하는 분석 도구다.",
    "출원상표의 표장 구성을 분석한다: 표장 유형(문자/도형/결합 등), 문자 요소별 문자 종류와 칭호(한글 발음 표기), 도형 요소 설명, 요부(식별력의 중심이 되는 부분).",
    "상표법 33조 1항 각호(보통명칭·관용표장·기술적 표장·현저한 지리적 명칭·흔한 성명·간단하고 흔한 표장·기타 식별력 없음)에 해당할 '가능성'이 있으면 distinctivenessFlags 에 참고용으로 적는다. 단정하지 말고 '의심' 수준으로만 표시한다.",
    "판단이 어려운 항목은 reviewNotes 에 '확인 필요' 사항으로 남긴다."
  ].join("\n"),
  schema: {
    type: "object",
    required: ["markType", "textElements", "figureDescription", "dominantPart", "distinctivenessFlags", "reviewNotes"],
    properties: {
      markType: { type: "string", enum: ["문자", "도형", "결합", "입체", "소리", "기타"] },
      textElements: {
        type: "array",
        items: {
          type: "object",
          required: ["text", "script", "reading"],
          properties: {
            text: { type: "string" },
            script: { type: "string", enum: ["한글", "영문", "한자", "기타"] },
            reading: { type: "string" }
          }
        }
      },
      figureDescription: { type: ["string", "null"] },
      dominantPart: { type: ["string", "null"] },
      distinctivenessFlags: { type: "array", items: { type: "string" } },
      reviewNotes: { type: "array", items: { type: "string" } }
    }
  }
};

// ② 외국어 의미·칭호 산출
export const FOREIGN_MEANING = {
  promptKey: "foreign_meaning",
  role: [
    "너는 대한민국 상표심사관을 보조하는 분석 도구다.",
    "표장의 문자 요소에 대해 (1) 한국 일반 수요자 기준의 자연스러운 칭호(한글 발음 표기)와 (2) 외국어 단어의 의미를 정리한다.",
    "의미가 확실하지 않으면 confidence 를 낮추고, 사전에서 확인되지 않는 조어(만들어진 말)는 meaning 을 \"unknown\" 으로 남긴다.",
    "칭호는 실제 수요자가 부를 법한 발음만 적는다. 억지스러운 변형은 만들지 않는다."
  ].join("\n"),
  schema: {
    type: "object",
    required: ["readings", "foreignMeaning"],
    properties: {
      readings: {
        type: "array",
        items: {
          type: "object",
          required: ["text", "reading"],
          properties: {
            text: { type: "string" },
            reading: { type: "string" }
          }
        }
      },
      foreignMeaning: {
        type: "array",
        items: {
          type: "object",
          required: ["term", "language", "meaning", "confidence"],
          properties: {
            term: { type: "string" },
            language: { type: "string" },
            meaning: { type: "string" },
            confidence: { type: "string", enum: ["high", "medium", "low", "unknown"] }
          }
        }
      }
    }
  }
};

// ③ 지정상품 정리 (상품명 정규화·류 구분만 LLM, 유사군코드는 코드 매칭)
export const GOODS_NORMALIZE = {
  promptKey: "goods_normalize",
  role: [
    "너는 대한민국 상표심사관을 보조하는 분석 도구다.",
    "붙여넣은 지정상품 목록을 상품 단위로 분리·정규화한다. 상품명은 원문 표기를 유지하되 앞뒤 군더더기(번호·기호)만 제거한다.",
    "각 상품의 니스(NICE) 분류 류(class)를 적는다. 입력에 류가 명시되어 있으면 그 값을 그대로 쓰고, 명시되어 있지 않고 확실하지 않으면 \"unknown\" 으로 남긴다.",
    "유사군코드는 절대 생성하지 마라. 유사군코드 부여는 도구의 기준표가 담당한다."
  ].join("\n"),
  schema: {
    type: "object",
    required: ["goods"],
    properties: {
      goods: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "class"],
          properties: {
            name: { type: "string" },
            class: { type: ["integer", "string"] }
          }
        }
      }
    }
  }
};

// 목 모드용 샘플 응답 — LLM 없이 화면 흐름 확인 [지시서 7]
export const MOCK_SAMPLES = {
  mark_structure: {
    markType: "결합",
    textElements: [
      { text: "SUNRISE", script: "영문", reading: "선라이즈" },
      { text: "선라이즈", script: "한글", reading: "선라이즈" }
    ],
    figureDescription: "떠오르는 해 도형 (샘플)",
    dominantPart: "SUNRISE",
    distinctivenessFlags: ["33조1항3호(기술적 표장) 해당 가능성 검토 필요 (샘플)"],
    reviewNotes: ["목 모드 샘플 응답입니다. 실제 분석이 아닙니다."]
  },
  foreign_meaning: {
    readings: [
      { text: "SUNRISE", reading: "선라이즈" },
      { text: "선라이즈", reading: "선라이즈" }
    ],
    foreignMeaning: [
      { term: "SUNRISE", language: "영어", meaning: "해돋이, 일출", confidence: "high" }
    ]
  },
  goods_normalize: {
    goods: [
      { name: "티셔츠", class: 25 },
      { name: "운동화", class: 25 },
      { name: "모자", class: 25 }
    ]
  }
};
