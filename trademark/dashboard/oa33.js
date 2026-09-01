// 33조 거절이유 문구 생성기 [의통서 SPEC v2]
//
// 파이프라인: 판단(LLM, 코퍼스 제약 없음) → 규칙 교차검사(코드) → 문구 작성(LLM, 템플릿·관용표현 골격)
//             → 금지어·증거·정합성 검증(코드) → [검토 필요] 목록(코드)
// 원칙: 판단은 자유롭게, 문장은 코퍼스(템플릿·관용표현) 안에서.
// ※ 앵커 선택·코퍼스 충실성(fidelity) 단계는 원문 코퍼스 파일을 받은 뒤 추가한다. [SPEC §4]
// ※ 34조 계열은 코퍼스 전무 — 이 생성기는 33조 1항 전용. [SPEC §9]

import { callJson, chat } from "../shared/llm.js";
import { loadSettings } from "../shared/settings.js";
import {
  TEMPLATES, PHRASEBANK, QUALITY_VOCAB,
  assembleGroundsTitle, ruleGrounds,
  FORBIDDEN_PATTERNS, UNVERIFIED_CLAIM_PATTERNS, buildClosing
} from "./oa33-data.js";

const el = (id) => document.getElementById(id);

const state = {
  getContext: null,       // () => { caseId, markVersion }
  addGeneratedGround: null,
  analysis: null,
  autoDefaults: [],       // 자동 채택된 열린 질문 기본값
  ruleWarning: "",
  finalText: "",
  flags: []               // { severity: "필수확인"|"확인", text }
};

function setStatus(text, tone = "") {
  const target = el("oaStatus");
  target.textContent = text;
  target.className = "status" + (tone ? ` ${tone}` : "");
}

// ---------- 공통 시스템 프롬프트 [SPEC §7-1] ----------

const COMMON_SYSTEM = [
  "당신은 특허청 상표 심사관의 의견제출통지서 작성을 보조하는 도우미입니다.",
  "상표법 제33조 제1항(식별력 없는 상표, 특히 제3호 성질표시)에 근거한 거절이유를 다룹니다.",
  "",
  "절대 규칙",
  "- 확인되지 않은 사용례·기사·선등록상표를 사실처럼 쓰지 않습니다.",
  "- 최종 문구에 판례 번호, 법리 서술을 넣지 않습니다.",
  "- 확신 없는 의미 풀이는 지어내지 않고 검토 필요로 넘깁니다.",
  "- 문어체·경어체(\"~습니다\")를 유지하고, 구성 부분은 큰따옴표, 의미 풀이는 작은따옴표를 씁니다."
].join("\n");

// ---------- 1단계: 심사 판단 노트 [SPEC §7-2] ----------

const ANALYSIS_SCHEMA = {
  type: "object",
  required: ["components", "decomposition_rationale", "alternatives", "overall_concept",
    "quality_types", "new_concept_risk", "ground", "strength", "weaknesses", "open_questions", "should_refuse"],
  properties: {
    components: {
      type: "array", minItems: 1,
      items: {
        type: "object",
        required: ["text", "meaning", "role", "script", "confidence"],
        properties: {
          text: { type: "string" },
          meaning: { type: ["string", "null"] },
          role: { type: "string", enum: ["성질표시", "흔한용어", "보통명칭", "지명", "성씨", "간단흔한", "다수공존", "도형"] },
          script: { type: "string" },
          source_word: { type: ["string", "null"] },
          is_translit: { type: "boolean" },
          confidence: { type: "number" }
        }
      }
    },
    decomposition_rationale: { type: "string" },
    alternatives: {
      type: "array",
      items: {
        type: "object", required: ["reading", "why_rejected"],
        properties: { reading: { type: "string" }, why_rejected: { type: "string" } }
      }
    },
    overall_concept: { type: "string" },
    concept_by_goods: { type: "object" },
    quality_types: { type: "array", items: { type: "string" } },
    new_concept_risk: { type: "string" },
    ground: {
      type: "object", required: ["grounds", "template_type", "rationale"],
      properties: {
        grounds: { type: "array", minItems: 1, items: { type: "integer" } },
        template_type: { type: "string", enum: ["A", "B", "C", "D", "E", "F", "G"] },
        rationale: { type: "string" },
        alternatives: { type: "array" }
      }
    },
    strength: { type: "string", enum: ["강", "중", "약"] },
    weaknesses: {
      type: "array",
      items: {
        type: "object", required: ["point", "severity"],
        properties: {
          point: { type: "string" },
          severity: { type: "string", enum: ["낮음", "중간", "높음"] },
          mitigation: { type: ["string", "null"] }
        }
      }
    },
    open_questions: {
      type: "array",
      items: {
        type: "object", required: ["question", "options", "default"],
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          default: { type: "string" }
        }
      }
    },
    should_refuse: { type: "boolean" }
  }
};

const ANALYZE_ROLE = COMMON_SYSTEM + "\n\n" + [
  "지금은 1단계(판단)입니다. 심사관처럼 사안을 분석하고 판단하십시오.",
  "이 단계에서는 심사기준·일반 법리를 자유롭게 참고하되, 그 내용을 최종 문구에 옮기지는 않습니다.",
  "",
  "다음을 순서대로 판단하여 JSON으로 출력하십시오. 각 판단에는 이유를 붙입니다.",
  "1. 구성 분해: 표장을 구성 부분으로 나누고 각 부분의 텍스트·문자 종류(script)·의미·역할을 정합니다. 한글음역이면 원어(source_word)를 밝힙니다. 심사관 메모에 의미가 주어졌으면 그대로 따르고, 없으면 사전적·거래사회 통용 의미를 제시하되 확신도(confidence)를 0~1로 표시합니다.",
  "2. 대안 분해: 다르게 나눌 수 있거나 다르게 읽힐 수 있으면(조어 인식 가능성 등) 그 대안과 채택하지 않은 이유를 씁니다.",
  "3. 전체 관념(overall_concept): 지정상품에 사용될 경우 수요자가 직감하는 의미. 상품군에 따라 다르면 concept_by_goods 에 나눠 씁니다.",
  `4. 성질 종류(quality_types): 상품이면 ${QUALITY_VOCAB.goods.join("·")}, 서비스업이면 ${QUALITY_VOCAB.service.join("·")} 중 해당하는 것만.`,
  "5. 결합 판단(new_concept_risk): 결합으로 새로운 관념이 형성된다는 반론 가능성과 설득력.",
  "6. 조항·유형(ground): 적용 조항(3·4·5·6·7호 조합)과 유형(A~G)을 정하고 이유를 씁니다. 제3호 성질표시로 보기에 무리가 있으면 제7호 단독이 더 안전한지 반드시 검토합니다. 제4호·제6호는 명확할 때만 부가합니다.",
  "7. 강도 평가(strength): 의견서 반박을 견딜 수 있는지 강/중/약. 약점은 심각도와 함께 weaknesses 에 나열하고, 보강 가능하면 mitigation 에 씁니다.",
  "8. 열린 질문(open_questions): 심사관의 답이 있어야 초안이 달라지는 사항을 선택지·기본값과 함께. 없으면 빈 배열.",
  "9. should_refuse: 거절이유 성립이 어렵다고 판단되면 false.",
  "",
  "유형 분류 기준: A 결합상표 기본형(3+7호) / B 전체 직감형(3+7호) / C 공익상 독점 부적합(사용실태 증거 필요) / D 다수공존형(7호 단독, 선등록 공존 증거 필요) / E 현저한 지리적 명칭 결합(4호 부가) / F 간단하고 흔한 표장(6호 부가) / G 도형 결합 부가 블록."
].join("\n");

async function runAnalyze() {
  const context = state.getContext();
  const settings = await loadSettings();
  if (settings.mockMode) {
    setStatus("33조 생성기는 목 모드를 지원하지 않습니다. 실제 LLM 연결에서 사용해 주세요.", "warn");
    return;
  }
  const mark = el("oaMark").value.trim();
  if (!mark) {
    setStatus("표장을 입력해 주세요.", "error");
    return;
  }
  el("oaAnalyzeBtn").disabled = true;
  setStatus("1단계 — 심사 판단 실행 중...");
  try {
    const userContent = [
      `표장: ${mark}`,
      `지정상품: ${el("oaGoods").value.trim() || "전부"}`,
      `심사관 메모: ${el("oaMemo").value.trim() || "없음"}`,
      `조항 지정: ${el("oaGroundsHint").value.trim() || "없음"}`
    ].join("\n");

    const result = await callJson({
      promptKey: "oa33_analyze",
      role: ANALYZE_ROLE,
      schema: ANALYSIS_SCHEMA,
      userContent,
      temperature: 0.2
    });
    if (!result.ok) {
      setStatus(`판단 실패: ${result.errors.join(" / ")}\n원문: ${result.raw.slice(0, 300)}`, "error");
      return;
    }
    state.analysis = result.data;
    state.autoDefaults = [];
    // 규칙 엔진 교차검사 [SPEC 파이프라인]
    const ruled = ruleGrounds(state.analysis.components);
    const llmGrounds = [...state.analysis.ground.grounds].sort((a, b) => a - b);
    state.ruleWarning = JSON.stringify(ruled) !== JSON.stringify(llmGrounds)
      ? `규칙 엔진은 ${assembleGroundsTitle(ruled)}, LLM 판단은 ${assembleGroundsTitle(llmGrounds)} — 조항 불일치, 확인 필요`
      : "";
    renderAnalysisNote();
    if (state.analysis.should_refuse === false) {
      setStatus("분석 결과: 거절이유 성립이 어렵다는 판단입니다. 판단 노트를 확인하세요.", "warn");
      el("oaDraftBtn").disabled = true;
    } else {
      setStatus("판단 완료. 노트를 확인하고 [2단계 — 문구 생성]을 실행하세요.", "ok");
      el("oaDraftBtn").disabled = false;
    }
  } catch (error) {
    setStatus(`판단 실패: ${error.message}`, "error");
  } finally {
    el("oaAnalyzeBtn").disabled = false;
  }
}

function renderAnalysisNote() {
  const a = state.analysis;
  const note = el("oaNote");
  note.classList.remove("hidden");
  const lines = [];
  lines.push(`■ 구성 분해 (${a.decomposition_rationale})`);
  a.components.forEach((c) => {
    lines.push(`  - "${c.text}" [${c.role}/${c.script}] 의미: ${c.meaning ?? "unknown"}` +
      (c.source_word ? ` (원어: ${c.source_word})` : "") +
      (c.confidence < 0.8 ? ` ⚠ 확신도 ${c.confidence}` : ""));
  });
  if (a.alternatives?.length) {
    lines.push("■ 대안 분해");
    a.alternatives.forEach((alt) => lines.push(`  - ${alt.reading} → 기각: ${alt.why_rejected}`));
  }
  lines.push(`■ 전체 관념: ${a.overall_concept}`);
  lines.push(`■ 성질 종류: ${(a.quality_types || []).join(", ") || "—"}`);
  lines.push(`■ 결합 판단: ${a.new_concept_risk}`);
  lines.push(`■ 조항·유형: 상표법 제33조 제1항 ${assembleGroundsTitle(a.ground.grounds)} / 유형 ${a.ground.template_type} (${TEMPLATES[a.ground.template_type]?.name || ""})`);
  lines.push(`  이유: ${a.ground.rationale}`);
  if (state.ruleWarning) lines.push(`⚠ ${state.ruleWarning}`);
  lines.push(`■ 강도: ${a.strength}`);
  (a.weaknesses || []).forEach((w) => {
    lines.push(`  - 약점(${w.severity}): ${w.point}${w.mitigation ? ` → 보강: ${w.mitigation}` : ""}`);
  });
  if (a.should_refuse === false) lines.push("■ ⚠ 거절이유 성립 곤란 판단");
  if (a.open_questions?.length) {
    lines.push("■ 열린 질문 — 답을 '심사관 메모'에 적고 1단계를 다시 실행하거나, 그대로 진행하면 기본값이 자동 채택됩니다:");
    a.open_questions.forEach((q, i) => {
      lines.push(`  ${i + 1}. ${q.question}`);
      q.options.forEach((option) => lines.push(`     - ${option}`));
      lines.push(`     [기본: ${q.default}]`);
    });
  }
  note.textContent = lines.join("\n");
}

// ---------- 2단계(축약): 문구 작성 + 코드 검증 [SPEC §7-5, §6] ----------

function buildDraftPrompt() {
  const a = state.analysis;
  const type = a.ground.template_type;
  const template = TEMPLATES[type] || TEMPLATES.A;
  const hasFigure = a.components.some((c) => c.role === "도형");
  const evidence = collectEvidence();

  const parts = [];
  parts.push("지금은 문구 작성 단계입니다. 아래 판단 노트의 내용으로 거절이유 문구를 작성하십시오.");
  parts.push("");
  parts.push("## 판단 노트 (사안 고유 내용은 반드시 여기서만 가져올 것)");
  parts.push(JSON.stringify(a, null, 2));
  parts.push("");
  parts.push(`## 유형 ${type} 템플릿 골격 (문장 골격·관용표현은 여기서 벗어나지 말 것. {슬롯}은 사안 내용이 들어갈 자리)`);
  parts.push(template.skeleton);
  if (template.variant) parts.push("변형:\n" + template.variant);
  if (hasFigure) parts.push("도형 블록 (문자 분석 앞에 삽입):\n" + TEMPLATES.G.skeleton);
  parts.push("");
  parts.push("## 관용표현 사전 (표현 선택은 이 안에서)");
  parts.push(JSON.stringify(PHRASEBANK, null, 2));
  parts.push("");
  parts.push("## 증거 상태");
  parts.push(`사용실태 확인됨: ${evidence.use.verified ? "예 — " + evidence.use.items : "아니오"}`);
  parts.push(`선등록 공존 확인됨: ${evidence.coexist.verified ? "예 — " + evidence.coexist.items : "아니오"}`);
  parts.push("");
  parts.push("## 지켜야 할 것");
  parts.push("- 논리 순서: [도형 부정] → 구성 분해·의미 → 지정상품 사용 시 전체 관념 → 성질표시 해당(성질 종류 괄호) → 결합에 의한 새 관념 불형성 → 출처 식별 불가 → 등록 불가.");
  parts.push(`- 표제는 정확히 "[ 거절이유 ] 상표법 제33조 제1항 ${assembleGroundsTitle(a.ground.grounds)}" 로 시작.`);
  parts.push(`- 마지막 줄은 정확히 "${buildClosing()}" (일부 거절이면 심사관이 수정).`);
  parts.push("- 확인되지 않은 사용실태·선등록 공존 사실은 절대 쓰지 말고, 필요한 자리에는 [용례 확인 필요] 자리표시자를 남길 것.");
  parts.push("- weaknesses 중 mitigation 이 있는 항목은 문구에서 보강하되, 템플릿에 없는 법리 서술로 보강하지 말 것.");
  parts.push("- 출력: 표제부터 마무리(끝.)까지의 문구 전문만. 마크다운 장식·설명 없음.");
  return parts.join("\n");
}

function collectEvidence() {
  return {
    use: { verified: el("oaEvidenceUseChk").checked, items: el("oaEvidenceUse").value.trim() },
    coexist: { verified: el("oaEvidenceCoexistChk").checked, items: el("oaEvidenceCoexist").value.trim() }
  };
}

function stripFences(text) {
  return String(text || "").replace(/```[a-z]*\n?/gi, "").trim();
}

// 코드 측 검증: 금지어·미검증 주장·표제 정합성 → 수정·플래그 [SPEC §6]
function validateDraft(text) {
  const flags = [];
  let output = text;
  const evidence = collectEvidence();

  // 하드 차단: 판례·법리 서술
  FORBIDDEN_PATTERNS.forEach((pattern) => {
    if (pattern.test(output)) {
      output = output.replace(new RegExp(pattern.source, "g"), "[삭제됨 — 판례·법리 서술 금지]");
      flags.push({ severity: "필수확인", text: "판례·법리 서술이 감지되어 제거했습니다. 문장 연결을 확인하세요." });
    }
  });

  // 미검증 사실 주장
  Object.entries(UNVERIFIED_CLAIM_PATTERNS).forEach(([kind, patterns]) => {
    const verified = kind === "사용실태" ? evidence.use.verified : evidence.coexist.verified;
    if (!verified && patterns.some((pattern) => pattern.test(output))) {
      flags.push({ severity: "필수확인", text: `증거 미확보 상태에서 ${kind} 주장 표현이 포함되어 있습니다. 해당 문장을 삭제하거나 증거를 확인하세요.` });
    }
  });
  if (output.includes("[용례 확인 필요]")) {
    flags.push({ severity: "필수확인", text: "사실 확인: [용례 확인 필요] 자리표시자 — 검색 후 채워야 합니다." });
  }

  // 표제 정합성: 표제 조항 == 판단 노트 조항
  const expectedTitle = assembleGroundsTitle(state.analysis.ground.grounds);
  const titleMatch = output.match(/상표법 제33조 제1항\s*([^\n]+?)(?=\n|$)/);
  if (titleMatch && !titleMatch[1].trim().startsWith(expectedTitle)) {
    output = output.replace(titleMatch[0], `상표법 제33조 제1항 ${expectedTitle}`);
    flags.push({ severity: "확인", text: `표제 조항이 판단 노트와 달라 "${expectedTitle}" 로 교정했습니다.` });
  }
  return { output, flags };
}

// [검토 필요] 목록을 코드에서 조립 [SPEC §6-4]
function buildReviewFlags(validationFlags) {
  const a = state.analysis;
  const flags = [...validationFlags];
  if (a.strength === "약") {
    flags.unshift({
      severity: "필수확인",
      text: `거절이유 강도 '약': ${(a.weaknesses || []).map((w) => w.point).join(" / ") || "약점 검토"} — 7호 단독 전환 등 대안 검토.`
    });
  }
  (a.components || []).filter((c) => c.confidence < 0.8).forEach((c) => {
    flags.push({ severity: "확인", text: `구성 부분 의미: "${c.text}" 풀이(확신도 ${c.confidence})는 임의 해석 — 사전 정의 확인 필요.` });
  });
  if (!el("oaMemo").value.trim()) {
    flags.push({ severity: "확인", text: "전체 관념·성질 종류: 심사관 메모 없이 추론했습니다." });
  }
  state.autoDefaults.forEach((d) => {
    flags.push({ severity: "확인", text: `자동 가정: ${d}` });
  });
  if (state.ruleWarning) flags.push({ severity: "확인", text: state.ruleWarning });
  // 필수확인 먼저
  return flags.sort((x, y) => (x.severity === y.severity ? 0 : x.severity === "필수확인" ? -1 : 1));
}

async function runDraft() {
  if (!state.analysis) return;
  el("oaDraftBtn").disabled = true;
  setStatus("2단계 — 문구 생성 중...");
  // 열린 질문이 남아 있으면 기본값 자동 채택 기록 [SPEC §7-3]
  state.autoDefaults = (state.analysis.open_questions || []).map((q) => `"${q.question}" → 기본값 "${q.default}" 채택`);
  try {
    let raw = await chat({
      messages: [
        { role: "system", content: COMMON_SYSTEM },
        { role: "user", content: buildDraftPrompt() }
      ],
      temperature: 0.3
    });
    let text = stripFences(raw);

    // 금지어 위반 시 1회 재실행 [SPEC 재시도 정책]
    if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(text))) {
      raw = await chat({
        messages: [
          { role: "system", content: COMMON_SYSTEM },
          { role: "user", content: buildDraftPrompt() },
          { role: "assistant", content: text },
          { role: "user", content: "판례 번호·법리 서술이 포함되었다. 해당 표현을 모두 제거하고 문구 전문만 다시 출력하라." }
        ],
        temperature: 0.2
      });
      text = stripFences(raw);
    }

    const { output, flags } = validateDraft(text);
    state.finalText = output;
    state.flags = buildReviewFlags(flags);

    el("oaDraftOut").value = output;
    el("oaDraftOut").classList.remove("hidden");
    renderFlags();
    el("oaInsertBtn").disabled = false;
    setStatus("문구 생성 완료. [검토 필요] 목록을 확인·수정한 뒤 통지서에 추가하세요.", "ok");
  } catch (error) {
    setStatus(`문구 생성 실패: ${error.message}`, "error");
  } finally {
    el("oaDraftBtn").disabled = false;
  }
}

function renderFlags() {
  const container = el("oaFlags");
  container.innerHTML = "";
  if (state.flags.length === 0) {
    container.classList.add("hidden");
    return;
  }
  container.classList.remove("hidden");
  const title = document.createElement("div");
  title.className = "flags-title";
  title.textContent = "[검토 필요]";
  container.appendChild(title);
  state.flags.forEach((flag) => {
    const line = document.createElement("div");
    line.className = "flag-line" + (flag.severity === "필수확인" ? " must" : "");
    line.textContent = `- ${flag.severity === "필수확인" ? "(필수확인) " : ""}${flag.text}`;
    container.appendChild(line);
  });
}

function insertToNotice() {
  if (!state.finalText || !state.addGeneratedGround) return;
  // 통지서 조립기가 자체 표제([거절이유 n])를 붙이므로 생성 문구의 표제 줄은 제거
  const body = el("oaDraftOut").value.replace(/^\[ ?거절이유 ?\d*\][^\n]*\n?/, "").trim();
  const title = `상표법 제33조 제1항 ${assembleGroundsTitle(state.analysis.ground.grounds)}`;
  state.addGeneratedGround(title, "AI 생성 문구 (검토 필요)", body);
  setStatus("거절이유로 추가했습니다. 아래 [초안 생성]으로 통지서에 반영하세요.", "ok");
}

// ---------- 초기화 ----------

export function initOa33({ getContext, addGeneratedGround, prefill }) {
  state.getContext = getContext;
  state.addGeneratedGround = addGeneratedGround;

  el("oaAnalyzeBtn").addEventListener("click", () => void runAnalyze());
  el("oaDraftBtn").addEventListener("click", () => void runDraft());
  el("oaInsertBtn").addEventListener("click", insertToNotice);
  el("oaEvidenceUseChk").addEventListener("change", () => {
    el("oaEvidenceUse").classList.toggle("hidden", !el("oaEvidenceUseChk").checked);
  });
  el("oaEvidenceCoexistChk").addEventListener("change", () => {
    el("oaEvidenceCoexist").classList.toggle("hidden", !el("oaEvidenceCoexistChk").checked);
  });
  el("oaFillBtn").addEventListener("click", prefill);
}

// 승인 1 확정본으로 표장·지정상품 자동 채움 (notice.js 가 호출)
export function fillFromMarkVersion(markVersion) {
  if (!markVersion?.data) return false;
  const mark = markVersion.data;
  el("oaMark").value = (mark.textElements || []).map((item) => item.text).join(" ") || "";
  const goods = (mark.goods || []).map((g) => `${g.name}(${g.class === "unknown" ? "류미상" : "제" + g.class + "류"})`).join(", ");
  el("oaGoods").value = goods || "전부";
  return true;
}
