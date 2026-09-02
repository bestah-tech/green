// 모듈 2 — 정교 검색식 10종 생성 (심사관 질의어 설계 지침 이식) [지시서 5. 모듈 2]
//
// 심사관이 실무에서 쓰는 "질의어(검색식) 설계 지침"을 그대로 프롬프트화한 것.
// 출원상표명 하나로 상표검색시스템(kiponet3-ts) 문법의 검색식 10종을 생성한다.
// 글자 수(20/10+10)·기호(+ & * ? /) 규칙은 코드(query-builder.validateExpertExpression)가 교차검증한다.

export const QUERY_EXPERT = {
  promptKey: "query_expert",
  role: [
    "너는 특허청 상표 심사용 질의어(검색식) 설계 전문가다. 출원상표명 하나로 아래 규칙에 따라 검색식 10개를 생성한다.",
    "",
    "## 0단계: 출력 전 사전 분석 (반드시 수행)",
    "1. 표기 확정: 한글/영문 표기를 모두 확보 (한쪽만 있으면 나머지를 생성).",
    "2. 발음 전사: 음운변동(받침 중화·연음·경음화)을 반영한 실제 발음 표기. 예) 꽃채마루 → [꼳채마루].",
    "3. 분절 결정: 자연스러운 2항 분절 지점을 정하고 앞항·뒷항의 글자 수를 정확히 센다 (/ 적용 여부를 좌우하므로 생략 금지).",
    "4. 로마자 후보: 표준 로마자 + 실무 통용 표기 모두 확보.",
    "5. 두벌식 자판 변환: 한글 상표명을 영문 키로 변환.",
    "",
    "## 기호 규칙 (위반 시 재작성)",
    "/단어=어두 한정, 단어/=어미 한정, /단어/=완전일치, +=OR, &=AND(교차식 전용), *=다중문자 와일드카드, ?=단일문자 와일드카드.",
    "글자 수 원칙(절대): 단어(또는 결합 후 전체 문자열)가 3글자 이상 → / 전면 생략. 1~2글자 → 반드시 / 부착.",
    "  · 교차식 앞항이 2글자 이하 → /단어 (어두 고정). 뒷항이 2글자 이하 → 단어/ (어미 고정). 독립 2글자 약어 → /단어/ (양옆 고정).",
    "  · 국·영문 혼용 결합은 결합 후 전체 길이로 판단 (대개 3글자 이상 → / 생략).",
    "",
    "## 변형 생성 지침",
    "한글: 평음/경음/격음 치환(ㄱ↔ㄲ↔ㅋ, ㅈ↔ㅉ↔ㅊ, ㅂ↔ㅃ↔ㅍ, ㄷ↔ㄸ↔ㅌ, ㅅ↔ㅆ) / 모음 혼동(ㅐ↔ㅔ↔ㅒ↔ㅖ, ㅗ↔ㅜ↔ㅓ, ㅚ↔ㅙ↔ㅞ) / 받침 탈락·중화·치환 / 장음 삽입(가→가아) / 어미 연장(루→루우) / 복수형(스, 즈).",
    "영문: g↔k↔kk↔gg↔c↔q / j↔z↔ch↔sh / r↔l↔ll↔rr / b↔v↔bb / p↔f↔ph / s↔x↔th / 모음 다중표기(u↔oo↔ou↔uu↔eu, a↔ah↔ar, e↔ae↔ea↔ei, i↔y↔ee↔ie) / 어미 s·z·e 부가.",
    "두벌식 자판표: ㅂq ㅈw ㄷe ㄱr ㅅt ㅛy ㅕu ㅑi ㅐo ㅔp / ㅁa ㄴs ㅇd ㄹf ㅎg ㅗh ㅓj ㅏk ㅣl / ㅋz ㅌx ㅊc ㅍv ㅠb ㅜn ㅡm (된소리·ㅒㅖ는 Shift).",
    "",
    "## 검색식 10종 (순서·개수 고정)",
    "1) 한글 발음·오타 극한 결합식 — 정확히 20단어, + 전용",
    "2) 영문 로마자 표기 결합식1 — 정확히 20단어, + 전용",
    "3) 영문 스펠링 심화(자음·모음·어미 우회) 결합식2 — 정확히 20단어, + 전용",
    "4) 국·영문 혼용 결합식(한글 앞 + 영문 뒤) — 정확히 20단어, + 전용",
    "5) 영·국문 혼용 결합식(영문 앞 + 한글 뒤) — 정확히 20단어, + 전용",
    "6) 두벌식 자판 오타 + 초성·약어 특화식 — 정확히 20단어, + 전용, 2글자 약어에만 /단어/",
    "7) 한글 음절 2항 교차식 — 앞항 정확히 10 & 뒷항 정확히 10, 형식 (a1+..+a10)&(b1+..+b10), 와일드카드 금지",
    "8) 영문 분절 2항 교차식 — 10 & 10, 와일드카드 금지",
    "9) 국·영문 혼용 분절 2항 교차식 — 10 & 10, 와일드카드 금지",
    "10) 와일드카드(*,?) 전용 포괄 결합식 — 정확히 20단어, + 만(& 절대 금지)",
    "",
    "## 자체 검증 (출력 직전 반드시 셀 것)",
    "- 1~6,10번: +로 나눈 단어가 정확히 20개인가 (직접 셀 것).",
    "- 7~9번: 앞항 10 / 뒷항 10인가.",
    "- 각 식 내부에 완전 중복 단어가 없는가.",
    "- 3글자 이상에 불필요한 /가 없는가. 1~2글자에 /가 빠지지 않았는가(특히 7~9 교차식, 6번 초성).",
    "- 10번에 &가 섞이지 않았는가. 7~9번에 *,?가 섞이지 않았는가.",
    "- 원 상표명 자체가 1번(한글) 또는 2번(영문) 첫 단어로 포함되는가.",
    "각 query 는 위 문법 그대로의 검색식 문자열 하나만 넣는다(설명·번호 붙이지 마라)."
  ].join("\n"),
  schema: {
    type: "object",
    required: ["expressions"],
    properties: {
      markKor: { type: ["string", "null"] },
      markEng: { type: ["string", "null"] },
      pronunciation: { type: ["string", "null"] },
      segmentation: {
        type: ["object", "null"],
        properties: {
          front: { type: ["string", "null"] },
          frontLen: { type: ["integer", "null"] },
          back: { type: ["string", "null"] },
          backLen: { type: ["integer", "null"] },
          slashNote: { type: ["string", "null"] }
        }
      },
      dvorak: { type: ["string", "null"] },
      expressions: {
        type: "array",
        minItems: 10,
        items: {
          type: "object",
          required: ["no", "title", "query"],
          properties: {
            no: { type: "integer" },
            title: { type: "string" },
            note: { type: ["string", "null"] },
            query: { type: "string" }
          }
        }
      },
      similarQueryRecommend: { type: ["string", "null"] },
      conceptSimilar: { type: ["string", "null"] }
    }
  }
};

// 목 모드 샘플 (SALTWELL/솔트웰 예시 — 개수 규칙을 만족하는 형태만 예시)
export const QUERY_EXPERT_MOCK = {
  query_expert: {
    markKor: "솔트웰",
    markEng: "SALTWELL",
    pronunciation: "[솔트웰]",
    segmentation: { front: "솔트", frontLen: 2, back: "웰", backLen: 1, slashNote: "앞 2글자 → /솔트, 뒤 1글자 → 웰/" },
    dvorak: "solteuwel",
    expressions: [
      { no: 1, title: "한글 발음·오타 극한 결합식", note: "경음·모음 혼동 축 (샘플)",
        query: "솔트웰+쏠트웰+솔트웨+솔트월+솔트웰스+솔투웰+솔트왤+솔드웰+솔트벨+솔트웰르+솔티웰+솔트웰루+솔트웰라+솔트웰리+솔트웰로+솔트웰레+솔트웰라이+솔트웰스으+솔트웰즈+솔트웰릐" },
      { no: 2, title: "영문 로마자 표기 결합식1", note: "(샘플)",
        query: "SALTWELL+SALTWEL+SALTWELLE+SALTWEIL+SALTVELL+SALTWEHL+SALTWAEL+SOLTWELL+SALTWAL+SALTUELL+SALTWELS+SALTWELZ+SALTWEHLL+SALTWELLL+SALTWEALL+SALTWYLL+SALTWEELL+SALTWELLS+SALTWAELL+SALTWOELL" },
      { no: 3, title: "영문 스펠링 심화 결합식2", note: "(샘플)",
        query: "SALTVEL+SALTFELL+SALTPHEL+CALTWELL+QALTWELL+SALTWELR+SALTWELH+SALTWEHL+SAULTWELL+SARLTWELL+SALTWEILL+SALTWAILL+SALTWEYLL+ZALTWELL+XALTWELL+SALDWELL+SALTUELL+SALTWEHLL+SALTWEOLL+SALTWEULL" },
      { no: 4, title: "국·영문 혼용(한글 앞+영문 뒤)", note: "(샘플)",
        query: "솔트WELL+솔트WEL+솔트WELLE+솔트VELL+솔트WEIL+쏠트WELL+솔투WELL+솔트WAL+솔트WELS+솔트WELZ+솔트WEHL+솔트WYLL+솔트WEALL+솔트WEELL+솔트WELLL+솔트WAELL+솔트WEOLL+솔트WEULL+솔트WOLL+솔트WULL" },
      { no: 5, title: "영·국문 혼용(영문 앞+한글 뒤)", note: "(샘플)",
        query: "SALT웰+SALT웨+SALT월+SALT웰스+SALT웰즈+SALT벨+SALT웰르+SALT왤+SALT웰라+SALT웰리+SALT웰로+SALT웰레+SALT웰라이+SALT웰으+SALT웰리아+SALT웰루+SALT웰라으+SALT웰르이+SALT웰스으+SALT웰릐" },
      { no: 6, title: "두벌식 자판 오타+초성·약어", note: "2글자 약어 /SW/ (샘플)",
        query: "solteuwel+thffmxdnpf+solteuwels+soltuwel+solteuwal+solteuwer+solteuwol+solteuweil+solteuwell+solteuwelz+/SW/+solteuwarl+solteuwul+solteuwil+solteuweel+solteuwoel+solteuwuel+solteuwaell+solteuweoll+solteuweull" },
      { no: 7, title: "한글 음절 2항 교차식", note: "(샘플)",
        query: "(/솔트+/쏠트+/솔투+/솔드+/솔티+/솔타+/솔토+/솔테+/솔+/소울)&(웰/+웨/+월/+벨/+왤/+웰스/+웰즈/+웰르/+엘/+would)" },
      { no: 8, title: "영문 분절 2항 교차식", note: "(샘플)",
        query: "(/SALT+/SALD+/SAULT+/SARLT+/CALT+/QALT+/ZALT+/XALT+/SALTT+/SALTH)&(WELL/+WEL/+VELL/+WEIL/+WAEL/+WYLL/+WEALL/+WEELL/+WELS/+WELZ/)" },
      { no: 9, title: "국·영문 혼용 분절 2항 교차식", note: "(샘플)",
        query: "(/솔트+/쏠트+/SALT+/SALD+/솔투+/솔드+/CALT+/QALT+/솔티+/솔타)&(WELL/+웰/+웨/+월/+벨/+WEL/+VELL/+웰스/+웰즈/+WEIL/)" },
      { no: 10, title: "와일드카드 전용 포괄 결합식", note: "(샘플)",
        query: "솔트*+쏠트*+솔투*+솔드*+솔?웰+솔트웰*+SALT*+SALD*+CALT*+SAL?WELL+SALTW*+SALTV*+솔티*+솔타*+솔토*+솔테*+SALTWE*+SALTWA*+SALTWY*+SAL*WELL" }
    ],
    similarQueryRecommend: "솔트웰+SALTWELL",
    conceptSimilar: "소금우물(salt well) — 관념 유사는 칭호 유사와 별건으로 분리 검토 권장"
  }
};
