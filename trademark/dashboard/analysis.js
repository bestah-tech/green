// 모듈 1 — 출원상표 분석 [지시서 5. 모듈별 명세 / 모듈 1]
//
// 3단계 자동 분석: ① 표장 구성 → ② 외국어 의미·칭호 → ③ 지정상품 정리·유사군코드
// - 유사군코드는 LLM이 아니라 data/similar_group_codes.json 기준표 코드 매칭 (실패 시 unknown)
// - 결과는 모두 심사관이 직접 수정 가능
// - [승인 1] 을 누르면 markVersions 에 버전 고정, 이후 수정·재승인은 새 버전 (이전 버전 보존)

import { STORAGE_KEYS } from "../shared/constants.js";
import { loadSettings } from "../shared/settings.js";
import { callJson, buildImageContent, chunkArray } from "../shared/llm.js";
import { listCases, get, touchCase, addVersion, getAllByCase, setMockResponse, getMockResponse } from "../shared/db.js";
import { loadSimilarGroupTable, matchSimilarGroupCode } from "../shared/similar-groups.js";
import { MARK_STRUCTURE, FOREIGN_MEANING, GOODS_NORMALIZE, MOCK_SAMPLES } from "./analysis-prompts.js";

const el = (id) => document.getElementById(id);

const state = {
  settings: null,
  caseId: "",
  imageDataUrl: null,
  running: false
};

function setStatus(target, text, tone = "") {
  target.textContent = text;
  target.className = "status" + (tone ? ` ${tone}` : "");
}

// ---------- 출원건 선택 ----------

export async function refreshAnalysisCases() {
  const select = el("anCaseSelect");
  const cases = await listCases();
  const saved = await chrome.storage.local.get(STORAGE_KEYS.ACTIVE_CASE_ID);
  const activeCaseId = state.caseId || saved[STORAGE_KEYS.ACTIVE_CASE_ID] || "";

  select.innerHTML = "";
  if (cases.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "— 홈에서 출원건을 먼저 생성하세요 —";
    select.appendChild(option);
    state.caseId = "";
  } else {
    cases.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.title ? `${item.id} (${item.title})` : item.id;
      select.appendChild(option);
    });
    state.caseId = cases.some((c) => c.id === activeCaseId) ? activeCaseId : cases[0].id;
    select.value = state.caseId;
  }
  await refreshApproveState();
  await renderVersionList();
}

async function onCaseChange() {
  state.caseId = el("anCaseSelect").value;
  await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_CASE_ID]: state.caseId });
  await refreshApproveState();
  await renderVersionList();
}

async function refreshApproveState() {
  const chip = el("anApproveState");
  if (!state.caseId) {
    chip.textContent = "—";
    chip.className = "approve-chip";
    return;
  }
  const record = await get("cases", state.caseId);
  if (record?.approvedMarkVersionId) {
    const version = await get("markVersions", record.approvedMarkVersionId);
    chip.textContent = `승인 1 확정 (v${version?.seq ?? "?"})`;
    chip.className = "approve-chip done";
  } else {
    chip.textContent = "승인 1 미확정";
    chip.className = "approve-chip";
  }
}

// ---------- 진행 표시 ----------

function resetProgress() {
  el("anProgress").classList.remove("hidden");
  el("anProgress").querySelectorAll("li").forEach((li) => (li.className = ""));
}

function markProgress(step, cls) {
  const li = el("anProgress").querySelector(`li[data-step="${step}"]`);
  if (li) li.className = cls;
}

// ---------- 지정상품 입력 파싱 (코드 담당) ----------

// "제25류: 티셔츠, 바지" / "03 화장품 G1201" / 코드만 있는 줄 등 내부 시스템 복사 형식을
// [{ name, class|null, codes: [] }] 로 분해한다.
// 유사군코드(G1201, S120907 등)는 상품명이 아니라 codes 로 분리하고,
// 코드만 있는 줄은 직전 상품의 유사군코드로 붙인다.
const SIMILAR_CODE_RE = /^[A-Z]{1,2}\d{4,6}$/;

export function parseGoodsInput(text) {
  const items = [];
  String(text || "")
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      let klass = null;
      let rest = line;
      // "제25류:" 형식
      const classMatch = line.match(/제?\s*(\d{1,2})\s*류\s*[:：]?\s*/);
      if (classMatch) {
        klass = Number(classMatch[1]);
        rest = line.slice(classMatch.index + classMatch[0].length);
      } else {
        // "03 화장품 ..." 처럼 줄 맨 앞의 두 자리 숫자도 류로 인식
        const leading = line.match(/^(\d{1,2})\s+/);
        if (leading) {
          klass = Number(leading[1]);
          rest = line.slice(leading[0].length);
        }
      }
      rest
        .split(/[,，;；·\t]/)
        .map((part) => part.trim().replace(/^[-•.)\s]+/, "").trim())
        .filter(Boolean)
        .forEach((part) => {
          // 조각 안에서 유사군코드 토큰과 상품명 토큰 분리
          const tokens = part.split(/\s+/);
          const codes = tokens.filter((token) => SIMILAR_CODE_RE.test(token));
          const name = tokens.filter((token) => !SIMILAR_CODE_RE.test(token)).join(" ").trim();
          if (name) {
            items.push({ name, class: klass, codes });
          } else if (codes.length > 0 && items.length > 0) {
            // 코드만 있는 조각·줄 → 직전 상품에 붙인다
            items[items.length - 1].codes.push(...codes);
          }
        });
    });
  return items;
}

// ---------- 목 모드 샘플 자동 등록 ----------

async function seedMocksIfNeeded() {
  for (const [key, sample] of Object.entries(MOCK_SAMPLES)) {
    const existing = await getMockResponse(key);
    if (existing === null) await setMockResponse(key, sample);
  }
}

// ---------- 3단계 자동 분석 ----------

async function runAnalysis() {
  if (state.running) return;
  if (!state.caseId) {
    setStatus(el("anRunStatus"), "출원건을 먼저 선택(생성)해 주세요.", "error");
    return;
  }
  const markText = el("anMarkText").value.trim();
  const figureText = el("anFigureText").value.trim();
  const goodsText = el("anGoodsText").value.trim();
  if (!markText && !figureText && !state.imageDataUrl) {
    setStatus(el("anRunStatus"), "표장 텍스트, 도형 설명, 이미지 중 하나는 입력해야 합니다.", "error");
    return;
  }

  state.running = true;
  el("anRunBtn").disabled = true;
  setStatus(el("anRunStatus"), "분석 중...");
  resetProgress();

  state.settings = await loadSettings();
  if (state.settings.mockMode) await seedMocksIfNeeded();
  const runNote = el("anRunNote").value.trim();
  const result = {
    markType: "문자",
    textElements: [],
    figureDescription: figureText || null,
    dominantPart: null,
    foreignMeaning: [],
    goods: [],
    distinctivenessFlags: [],
    reviewNotes: []
  };
  const failures = [];

  try {
    // ① 표장 구성 분석
    markProgress(1, "running");
    const structureInput = [
      `표장 텍스트: ${markText || "(없음)"}`,
      `도형 요소 설명: ${figureText || "(없음)"}`,
      state.imageDataUrl ? "표장 이미지가 첨부되어 있다. 이미지도 함께 분석하라." : ""
    ].filter(Boolean).join("\n");
    const useImage = Boolean(state.imageDataUrl && state.settings.imageInput && !state.settings.mockMode);
    const step1 = await callJson({
      promptKey: MARK_STRUCTURE.promptKey,
      role: MARK_STRUCTURE.role,
      schema: MARK_STRUCTURE.schema,
      userContent: useImage ? buildImageContent(structureInput, [state.imageDataUrl]) : structureInput,
      runNote
    });
    if (step1.ok) {
      Object.assign(result, {
        markType: step1.data.markType,
        textElements: step1.data.textElements,
        figureDescription: step1.data.figureDescription,
        dominantPart: step1.data.dominantPart,
        distinctivenessFlags: step1.data.distinctivenessFlags,
        reviewNotes: step1.data.reviewNotes
      });
      markProgress(1, "done");
    } else {
      failures.push(`① 표장 구성: ${step1.errors.join(" / ")}${step1.raw ? `\n원문: ${step1.raw.slice(0, 200)}` : ""}`);
      markProgress(1, "failed");
    }

    // ② 외국어 의미·칭호 (문자 요소가 있을 때만)
    markProgress(2, "running");
    if (result.textElements.length > 0 || markText) {
      const terms = result.textElements.length > 0
        ? result.textElements.map((item) => item.text)
        : [markText];
      const step2 = await callJson({
        promptKey: FOREIGN_MEANING.promptKey,
        role: FOREIGN_MEANING.role,
        schema: FOREIGN_MEANING.schema,
        userContent: `문자 요소 목록:\n${terms.map((t) => `- ${t}`).join("\n")}`,
        runNote
      });
      if (step2.ok) {
        result.foreignMeaning = step2.data.foreignMeaning;
        // 칭호 병합: readings 로 textElements.reading 을 보완 (코드가 병합) [규약: 청크·병합은 코드]
        step2.data.readings.forEach((r) => {
          const target = result.textElements.find((item) => item.text === r.text);
          if (target && r.reading) target.reading = r.reading;
        });
        markProgress(2, "done");
      } else {
        failures.push(`② 외국어 의미: ${step2.errors.join(" / ")}`);
        markProgress(2, "failed");
      }
    } else {
      markProgress(2, "done"); // 문자 요소 없음 — 건너뜀
    }

    // ③ 지정상품 정리 + 유사군코드 부여
    markProgress(3, "running");
    if (goodsText) {
      const parsed = parseGoodsInput(goodsText);
      // 류가 비어 있는 항목만 LLM 으로 보완 (붙여넣기에 있던 류·코드는 건드리지 않는다)
      const needClass = parsed.filter((item) => !item.class);
      if (needClass.length > 0) {
        const classByName = new Map();
        const chunks = state.settings.mockMode ? [needClass] : chunkArray(needClass, 40);
        for (const chunk of chunks) {
          const step3 = await callJson({
            promptKey: GOODS_NORMALIZE.promptKey,
            role: GOODS_NORMALIZE.role,
            schema: GOODS_NORMALIZE.schema,
            userContent:
              "지정상품 목록 (JSON):\n" +
              JSON.stringify(chunk.map((item) => ({ name: item.name, class: null })), null, 2) +
              "\n\n각 항목의 니스분류 류(class)를 판단해 채워라. 확실하지 않으면 \"unknown\" 으로 남겨라.",
            runNote
          });
          if (step3.ok) {
            step3.data.goods.forEach((g) => classByName.set(g.name, g.class));
          } else {
            failures.push(`③ 지정상품 정리: ${step3.errors.join(" / ")}`);
          }
        }
        parsed.forEach((item) => {
          if (!item.class && classByName.has(item.name)) item.class = classByName.get(item.name);
        });
      }
      // 유사군코드: 붙여넣기에 코드가 있으면 그대로 사용, 없으면 기준표 매칭 (LLM 미사용)
      const table = await loadSimilarGroupTable();
      result.goods = parsed.map((item) => ({
        name: item.name,
        class: item.class ?? "unknown",
        similarGroupCode: item.codes.length > 0
          ? [...new Set(item.codes)].join(",")
          : matchSimilarGroupCode(table, item.name, item.class)
      }));
      markProgress(3, failures.some((f) => f.startsWith("③")) ? "failed" : "done");
    } else {
      result.reviewNotes.push("지정상품 목록이 입력되지 않았습니다.");
      markProgress(3, "done");
    }

    renderResult(result);
    if (failures.length > 0) {
      setStatus(el("anRunStatus"), `일부 단계 실패 — 실패한 항목은 직접 입력해 주세요.\n${failures.join("\n")}`, "warn");
    } else {
      setStatus(el("anRunStatus"), "분석 완료. 내용을 검토·수정한 뒤 [승인 1]로 확정하세요.", "ok");
    }
  } catch (error) {
    setStatus(el("anRunStatus"), `분석 실패: ${error.message}`, "error");
  } finally {
    state.running = false;
    el("anRunBtn").disabled = false;
  }
}

// ---------- 결과 렌더링 (편집 가능 테이블) ----------

// 행 구성 정의: 열마다 { key, type, options?, placeholder? }
const TABLE_DEFS = {
  textElements: {
    tbody: "anTextElements",
    columns: [
      { key: "text", type: "text", placeholder: "텍스트" },
      { key: "script", type: "select", options: ["한글", "영문", "한자", "기타"] },
      { key: "reading", type: "text", placeholder: "칭호(한글 표기)" }
    ],
    empty: { text: "", script: "한글", reading: "" }
  },
  foreignMeaning: {
    tbody: "anForeignMeaning",
    columns: [
      { key: "term", type: "text", placeholder: "단어" },
      { key: "language", type: "text", placeholder: "언어" },
      { key: "meaning", type: "text", placeholder: "의미 (모르면 unknown)" },
      { key: "confidence", type: "select", options: ["high", "medium", "low", "unknown"] }
    ],
    empty: { term: "", language: "", meaning: "", confidence: "unknown" }
  },
  goods: {
    tbody: "anGoods",
    columns: [
      { key: "name", type: "text", placeholder: "지정상품명" },
      { key: "class", type: "text", placeholder: "류 (숫자, 모르면 unknown)" },
      { key: "similarGroupCode", type: "text", placeholder: "유사군코드 (모르면 unknown)" }
    ],
    empty: { name: "", class: "unknown", similarGroupCode: "unknown" }
  },
  flags: {
    tbody: "anFlags",
    columns: [{ key: "value", type: "text", placeholder: "예: 33조1항3호(기술적 표장) 의심" }],
    empty: { value: "" }
  },
  notes: {
    tbody: "anNotes",
    columns: [{ key: "value", type: "text", placeholder: "확인 필요 사항" }],
    empty: { value: "" }
  }
};

function buildRow(defKey, rowData) {
  const def = TABLE_DEFS[defKey];
  const tr = document.createElement("tr");
  def.columns.forEach((col) => {
    const td = document.createElement("td");
    let input;
    if (col.type === "select") {
      input = document.createElement("select");
      col.options.forEach((opt) => {
        const option = document.createElement("option");
        option.value = opt;
        option.textContent = opt;
        input.appendChild(option);
      });
      input.value = rowData[col.key] ?? col.options[0];
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.value = rowData[col.key] ?? "";
      input.placeholder = col.placeholder || "";
      // unknown 값은 심사관 입력 필요 표시 [설계 원칙 6]
      const syncUnknown = () => input.classList.toggle("unknown-value", input.value.trim() === "unknown");
      input.addEventListener("input", syncUnknown);
      syncUnknown();
    }
    input.dataset.key = col.key;
    td.appendChild(input);
    tr.appendChild(td);
  });
  const delTd = document.createElement("td");
  delTd.className = "row-del";
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "row-del-btn";
  delBtn.textContent = "✕";
  delBtn.title = "행 삭제";
  delBtn.addEventListener("click", () => tr.remove());
  delTd.appendChild(delBtn);
  tr.appendChild(delTd);
  return tr;
}

function fillTable(defKey, rows) {
  const tbody = el(TABLE_DEFS[defKey].tbody).querySelector("tbody");
  tbody.innerHTML = "";
  rows.forEach((row) => tbody.appendChild(buildRow(defKey, row)));
}

function readTable(defKey) {
  const def = TABLE_DEFS[defKey];
  const rows = [];
  el(def.tbody).querySelectorAll("tbody tr").forEach((tr) => {
    const row = {};
    let hasValue = false;
    tr.querySelectorAll("[data-key]").forEach((input) => {
      const value = String(input.value || "").trim();
      row[input.dataset.key] = value;
      if (value && input.tagName !== "SELECT") hasValue = true;
    });
    if (hasValue) rows.push(row);
  });
  return rows;
}

function renderResult(result) {
  el("anResultPanel").classList.remove("hidden");
  el("anMarkType").value = result.markType || "문자";
  el("anFigureDesc").value = result.figureDescription || "";
  el("anDominant").value = result.dominantPart || "";
  fillTable("textElements", result.textElements || []);
  fillTable("foreignMeaning", result.foreignMeaning || []);
  fillTable("goods", result.goods || []);
  fillTable("flags", (result.distinctivenessFlags || []).map((value) => ({ value })));
  fillTable("notes", (result.reviewNotes || []).map((value) => ({ value })));
}

// 화면의 현재(심사관 수정 반영) 내용을 데이터 모델로 수집
function collectResult() {
  const goods = readTable("goods").map((row) => {
    const classNum = Number(row.class);
    return {
      name: row.name,
      class: Number.isFinite(classNum) && row.class !== "" ? classNum : "unknown",
      similarGroupCode: row.similarGroupCode || "unknown"
    };
  });
  return {
    markType: el("anMarkType").value,
    textElements: readTable("textElements"),
    figureDescription: el("anFigureDesc").value.trim() || null,
    dominantPart: el("anDominant").value.trim() || null,
    foreignMeaning: readTable("foreignMeaning"),
    goods,
    distinctivenessFlags: readTable("flags").map((row) => row.value),
    reviewNotes: readTable("notes").map((row) => row.value)
  };
}

// ---------- 승인 1 (버전 고정) [설계 원칙 3·4] ----------

async function approveVersion() {
  if (!state.caseId) {
    setStatus(el("anApproveStatus"), "출원건을 먼저 선택해 주세요.", "error");
    return;
  }
  const data = collectResult();
  if (data.textElements.length === 0 && !data.figureDescription) {
    setStatus(el("anApproveStatus"), "문자 요소 또는 도형 설명이 최소 하나는 있어야 확정할 수 있습니다.", "error");
    return;
  }
  const unknownGoods = data.goods.filter((g) => g.similarGroupCode === "unknown").length;
  if (unknownGoods > 0) {
    const proceed = window.confirm(
      `유사군코드가 unknown 인 지정상품이 ${unknownGoods}건 있습니다.\n그대로 확정할까요? (나중에 새 버전으로 수정할 수 있습니다)`
    );
    if (!proceed) return;
  }
  try {
    const version = await addVersion("markVersions", state.caseId, data, {
      approvedAt: new Date().toISOString(),
      inputSnapshot: {
        markText: el("anMarkText").value.trim(),
        figureText: el("anFigureText").value.trim(),
        goodsText: el("anGoodsText").value.trim(),
        hasImage: Boolean(state.imageDataUrl)
      }
    });
    await touchCase(state.caseId, { approvedMarkVersionId: version.id });
    setStatus(el("anApproveStatus"), `승인 1 완료 — v${version.seq} 로 확정했습니다.`, "ok");
    await refreshApproveState();
    await renderVersionList();
  } catch (error) {
    setStatus(el("anApproveStatus"), `확정 실패: ${error.message}`, "error");
  }
}

// ---------- 버전 이력 ----------

async function renderVersionList() {
  const container = el("anVersionList");
  if (!state.caseId) {
    container.textContent = "아직 확정된 버전이 없습니다.";
    return;
  }
  const caseRecord = await get("cases", state.caseId);
  const versions = (await getAllByCase("markVersions", state.caseId)).sort((a, b) => b.seq - a.seq);
  if (versions.length === 0) {
    container.textContent = "아직 확정된 버전이 없습니다.";
    return;
  }
  container.innerHTML = "";
  versions.forEach((version) => {
    const item = document.createElement("div");
    item.className = "version-item";
    const tag = document.createElement("span");
    tag.className = "ver-tag";
    tag.textContent = `v${version.seq}`;
    const date = document.createElement("span");
    date.className = "ver-date";
    date.textContent = (version.approvedAt || version.createdAt || "").replace("T", " ").slice(0, 16);
    const current = document.createElement("span");
    current.className = "approve-chip" + (caseRecord?.approvedMarkVersionId === version.id ? " done" : "");
    current.textContent = caseRecord?.approvedMarkVersionId === version.id ? "현재 확정본" : "이전 버전";
    const loadBtn = document.createElement("button");
    loadBtn.type = "button";
    loadBtn.className = "btn";
    loadBtn.textContent = "불러오기";
    loadBtn.addEventListener("click", () => {
      renderResult(version.data);
      setStatus(el("anApproveStatus"), `v${version.seq} 내용을 불러왔습니다. 수정 후 [승인 1]을 누르면 새 버전이 됩니다.`, "ok");
    });
    item.appendChild(tag);
    item.appendChild(date);
    item.appendChild(current);
    item.appendChild(loadBtn);
    container.appendChild(item);
  });
}

// ---------- 이미지 입력 ----------

function onImageSelected(event) {
  const file = event.target.files?.[0];
  const preview = el("anImagePreview");
  if (!file) {
    state.imageDataUrl = null;
    preview.classList.add("hidden");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    state.imageDataUrl = String(reader.result);
    preview.src = state.imageDataUrl;
    preview.classList.remove("hidden");
  };
  reader.readAsDataURL(file);
}

// ---------- 초기화 ----------

export async function initAnalysis() {
  state.settings = await loadSettings();
  if (!state.settings.imageInput) el("anImageField").classList.add("hidden");

  el("anCaseSelect").addEventListener("change", () => void onCaseChange());
  el("anRunBtn").addEventListener("click", () => void runAnalysis());
  el("anApproveBtn").addEventListener("click", () => void approveVersion());
  el("anMarkImage").addEventListener("change", onImageSelected);
  document.querySelectorAll(".add-row-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const defKey = btn.dataset.add;
      const tbody = el(TABLE_DEFS[defKey].tbody).querySelector("tbody");
      tbody.appendChild(buildRow(defKey, { ...TABLE_DEFS[defKey].empty }));
    });
  });

  await refreshAnalysisCases();
}
