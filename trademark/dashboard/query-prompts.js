// 모듈 2 — 검색식 작성 LLM 프롬프트·스키마 정의 [지시서 5. 모듈 2 / K-QUERY 3레이어]
//
// 레이어 1 (추출·우선순위): 승인 1 확정본에서 검색 대상 용어를 뽑고 core/support 우선순위를 매긴다.
// 레이어 2 (확장): 용어별로 칭호 변형·철자 변형·관념 확장어를 생성한다.
// 레이어 3 (조립·검증)은 LLM이 아니라 코드가 담당한다 → shared/query-builder.js [설계 원칙 1]

// 레이어 1 — 검색 용어 추출·우선순위
export const QUERY_TERMS = {
  promptKey: "query_terms",
  role: [
    "너는 대한민국 상표심사관을 보조하는 선행상표 검색 준비 도구다.",
    "승인된 출원상표 분석 결과(JSON)를 보고, 선행상표 검색에 쓸 용어를 추출한다.",
    "kind 구분: \"표기\"(표장에 실제 적힌 문자 그대로), \"칭호\"(한글 발음 표기), \"관념\"(의미·번역어로 검색할 단어).",
    "priority 구분: \"core\"(요부·식별력의 중심이라 반드시 검색해야 하는 용어), \"support\"(부수 요소·참고용).",
    "요부(dominantPart)가 지정되어 있으면 그 요소의 표기와 칭호는 반드시 core 로 넣는다.",
    "식별력이 없는 부분(보통명칭·기술적 표현 등)만 단독으로 검색하는 용어는 만들지 않되, 결합된 전체 표장은 core 로 넣는다.",
    "reason 에는 그 용어를 왜 그 우선순위로 뽑았는지 한 문장으로 적는다."
  ].join("\n"),
  schema: {
    type: "object",
    required: ["terms"],
    properties: {
      terms: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["term", "kind", "priority", "reason"],
          properties: {
            term: { type: "string" },
            kind: { type: "string", enum: ["표기", "칭호", "관념"] },
            priority: { type: "string", enum: ["core", "support"] },
            reason: { type: "string" }
          }
        }
      }
    }
  }
};

// 레이어 2 — 용어별 변형·확장
export const QUERY_EXPAND = {
  promptKey: "query_expand",
  role: [
    "너는 대한민국 상표심사관을 보조하는 선행상표 검색 준비 도구다.",
    "주어진 검색 용어 목록의 각 용어(base)에 대해, 선행상표 검색망을 넓히는 변형(variant)을 생성한다.",
    "type 구분과 규칙:",
    "- \"발음변형\": 한국 일반 수요자가 실제로 혼동할 법한 한글 발음 변형만 만든다 (된소리/거센소리, 장단음, 모음 혼동, 받침 유무 등). 억지스러운 변형은 만들지 않는다.",
    "- \"철자변형\": 영문 용어의 흔한 철자 변형·발음이 같은 다른 철자 (예: C↔K, PH↔F, 모음 생략). 실제 상표 출원에서 나타날 법한 것만.",
    "- \"관념확장\": 의미가 같거나 사실상 동일하게 인식되는 번역어·동의어 (예: 해돋이↔일출↔SUNRISE). 의미가 확실한 경우에만 만들고, 조어(만들어진 말)는 관념확장을 만들지 않는다.",
    "- \"와일드카드\": 물음표(?)는 임의 문자 1자를 뜻한다 (예: w?n → win·won·wan). 모음 하나가 흔들리는 자리에만 쓴다. 검색은 기본적으로 부분일치이므로 앞뒤 결합을 잡으려고 ?를 붙일 필요는 없다. 슬래시(/)는 칭호 경계 고정(/CURO 는 CURO 로 시작)이며 필요할 때만 쓴다.",
    "variant 는 base 와 달라야 하며, 같은 값을 중복 생성하지 않는다.",
    "reason 에는 어떤 혼동·결합을 잡기 위한 변형인지 한 문장으로 적는다.",
    "변형이 마땅히 없는 용어는 건너뛰어도 된다 (빈 결과 강요 금지)."
  ].join("\n"),
  schema: {
    type: "object",
    required: ["variations"],
    properties: {
      variations: {
        type: "array",
        items: {
          type: "object",
          required: ["base", "variant", "type", "reason"],
          properties: {
            base: { type: "string" },
            variant: { type: "string" },
            type: { type: "string", enum: ["발음변형", "철자변형", "관념확장", "와일드카드"] },
            reason: { type: "string" }
          }
        }
      }
    }
  }
};

// 목 모드용 샘플 응답 (SUNRISE 선라이즈 예시 — 모듈 1 목 샘플과 짝을 이룬다)
export const QUERY_MOCK_SAMPLES = {
  query_terms: {
    terms: [
      { term: "SUNRISE", kind: "표기", priority: "core", reason: "요부로 지정된 영문 표기 (샘플)" },
      { term: "선라이즈", kind: "칭호", priority: "core", reason: "요부의 한글 칭호 (샘플)" },
      { term: "해돋이", kind: "관념", priority: "support", reason: "SUNRISE 의 의미로 관념 검색 (샘플)" }
    ]
  },
  query_expand: {
    variations: [
      { base: "선라이즈", variant: "썬라이즈", type: "발음변형", reason: "S 발음의 된소리 표기 혼동 (샘플)" },
      { base: "선라이즈", variant: "선라?즈", type: "와일드카드", reason: "모음 변형 자리를 임의 문자 1자로 (샘플)" },
      { base: "SUNRISE", variant: "SUNRIZE", type: "철자변형", reason: "S↔Z 발음 동일 철자 변형 (샘플)" },
      { base: "해돋이", variant: "일출", type: "관념확장", reason: "동일 의미 한자어 (샘플)" }
    ]
  }
};
