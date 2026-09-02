// 모듈 2 — 검색식 작성 [지시서 5. 모듈 2 / K-QUERY 3레이어 구조]
//
// 레이어 1: 승인 1 확정본에서 검색 용어 추출·우선순위 (LLM)
// 레이어 2: 용어별 칭호·철자 변형, 관념 확장 (LLM)
// 레이어 3: 검색식 조립·검증 (코드 — shared/query-builder.js, config/query_syntax.json 기준)
// 모든 결과는 심사관이 직접 수정할 수 있고, [승인 2] 를 누르면 searchBriefs 에 버전 고정.
// 승인 2 확정본은 모듈 3(검색 에이전트)이 검색식 목록으로 사용한다. [설계 원칙 3·4]

import { STORAGE_KEYS } from "../shared/constants.js";
import { loadSettings } from "../shared/settings.js";
import { callJson } from "../shared/llm.js";
import { listCases, get, touchCase, addVersion, getAllByCase, setMockResponse, getMockResponse } from "../shared/db.js";
import { loadQuerySyntax, buildQueries, validateQuery, validateExpertExpression } from "../shared/query-builder.js";
import { QUERY_TERMS, QUERY_EXPAND, QUERY_MOCK_SAMPLES } from "./query-prompts.js";
import { QUERY_EXPERT, QUERY_EXPERT_MOCK } from "./query-expert-prompts.js";

const el = (id) => document.getElementById(id);

const state = {
  caseId: "",
  markVersion: null,  // 승인 1 확정본
  syntax: null,       // query_syntax.json
  queries: []         // 조립된 검색식 [{ label, query, purpose, valid, issues }]
};

function setStatus(target, text, tone = "") {
  target.textContent = text;
  target.className = "status" + (tone ? ` ${tone}` : "");
}

// ---------- 출원건 선택 · 승인 1 확인 ----------

export async function refreshQueryCases() {
  const select = el("qCaseSelect");
  const cases = await listCases();
  const saved = await chrome.storage.local.get(STORAGE_KEYS.ACTIVE_CASE_ID);
  const active = state.caseId || saved[STORAGE_KEYS.ACTIVE_CASE_ID] || "";

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
    state.caseId = cases.some((c) => c.id === active) ? active : cases[0].id;
    select.value = state.caseId;
  }
  await loadMarkVersion();
  await renderBriefVersions();
}

async function onCaseChange() {
  state.caseId = el("qCaseSelect").value;
  await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_CASE_ID]: state.caseId });
  await loadMarkVersion();
  await renderBriefVersions();
}

async function loadMarkVersion() {
  state.markVersion = null;
  const chip = el("qApproveState");
  if (!state.caseId) {
    chip.textContent = "—";
    chip.className = "approve-chip";
    el("qTermsBtn").disabled = true;
    el("qExpertBtn").disabled = true;
    return;
  }
  const caseRecord = await get("cases", state.caseId);
  if (caseRecord?.approvedMarkVersionId) {
    state.markVersion = await get("markVersions", caseRecord.approvedMarkVersionId);
    chip.textContent = `승인 1 확정 (v${state.markVersion?.seq ?? "?"}) — 검색식 작성 가능`;
    chip.className = "approve-chip done";
    el("qTermsBtn").disabled = false;
    el("qExpertBtn").disabled = false;
  } else {
    chip.textContent = "승인 1 미확정 — 모듈 1에서 출원상표 분석을 먼저 확정하세요";
    chip.className = "approve-chip";
    el("qTermsBtn").disabled = true;
    el("qExpertBtn").disabled = true;
  }
}

// ---------- 편집 가능 테이블 (용어·변형) ----------

const TABLE_DEFS = {
  terms: {
    tbody: "qTermsTable",
    columns: [
      { key: "term", type: "text", placeholder: "검색 용어" },
      { key: "kind", type: "select", options: ["표기", "칭호", "관념"] },
      { key: "priority", type: "select", options: ["core", "support"] },
      { key: "reason", type: "text", placeholder: "선정 이유" }
    ],
    empty: { term: "", kind: "칭호", priority: "core", reason: "" }
  },
  variations: {
    tbody: "qVariationsTable",
    columns: [
      { key: "include", type: "checkbox" },
      { key: "base", type: "text", placeholder: "원 용어" },
      { key: "variant", type: "text", placeholder: "변형" },
      { key: "type", type: "select", options: ["발음변형", "철자변형", "관념확장", "와일드카드"] },
      { key: "reason", type: "text", placeholder: "변형 이유" }
    ],
    empty: { include: true, base: "", variant: "", type: "발음변형", reason: "" }
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
    } else if (col.type === "checkbox") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = rowData[col.key] !== false;
      td.className = "cell-checkbox";
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.value = rowData[col.key] ?? "";
      input.placeholder = col.placeholder || "";
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
      if (input.type === "checkbox") {
        row[input.dataset.key] = input.checked;
        return;
      }
      const value = String(input.value || "").trim();
      row[input.dataset.key] = value;
      if (value && input.tagName !== "SELECT") hasValue = true;
    });
    if (hasValue) rows.push(row);
  });
  return rows;
}

// ---------- 레이어 1: 용어 추출 (LLM) ----------

async function seedMocksIfNeeded() {
  for (const [key, sample] of Object.entries(QUERY_MOCK_SAMPLES)) {
    const existing = await getMockResponse(key);
    if (existing === null) await setMockResponse(key, sample);
  }
}

async function runTerms() {
  if (!state.markVersion) return;
  const status = el("qTermsStatus");
  el("qTermsBtn").disabled = true;
  setStatus(status, "용어 추출 중...");
  try {
    const settings = await loadSettings();
    if (settings.mockMode) await seedMocksIfNeeded();
    const mark = state.markVersion.data;
    const result = await callJson({
      promptKey: QUERY_TERMS.promptKey,
      role: QUERY_TERMS.role,
      schema: QUERY_TERMS.schema,
      userContent:
        "승인된 출원상표 분석 (JSON):\n" +
        JSON.stringify({
          markType: mark.markType,
          textElements: mark.textElements,
          dominantPart: mark.dominantPart,
          foreignMeaning: mark.foreignMeaning,
          distinctivenessFlags: mark.distinctivenessFlags
        }, null, 2)
    });
    if (!result.ok) throw new Error(result.errors.join(" / "));
    fillTable("terms", result.data.terms);
    el("qTermsPanel").classList.remove("hidden");
    el("qExpandBtn").disabled = false;
    setStatus(status, `용어 ${result.data.terms.length}개 추출 — 검토·수정 후 변형 생성을 실행하세요.`, "ok");
  } catch (error) {
    setStatus(status, `추출 실패: ${error.message}`, "error");
  } finally {
    el("qTermsBtn").disabled = !state.markVersion;
  }
}

// ---------- 레이어 2: 변형 생성 (LLM) ----------

async function runExpand() {
  const terms = readTable("terms");
  const status = el("qTermsStatus");
  if (terms.length === 0) {
    setStatus(status, "용어가 없습니다. 용어를 먼저 추출·입력해 주세요.", "error");
    return;
  }
  el("qExpandBtn").disabled = true;
  setStatus(status, "변형 생성 중...");
  try {
    const settings = await loadSettings();
    if (settings.mockMode) await seedMocksIfNeeded();
    const result = await callJson({
      promptKey: QUERY_EXPAND.promptKey,
      role: QUERY_EXPAND.role,
      schema: QUERY_EXPAND.schema,
      userContent:
        "검색 용어 목록 (JSON):\n" +
        JSON.stringify(terms.map((t) => ({ term: t.term, kind: t.kind })), null, 2) +
        "\n\n각 용어의 변형을 생성하라. base 는 반드시 위 목록의 term 값 중 하나여야 한다."
    });
    if (!result.ok) throw new Error(result.errors.join(" / "));
    // base 가 용어 목록에 없는 변형은 버린다 (코드 교차검사)
    const known = new Set(terms.map((t) => t.term));
    const usable = result.data.variations
      .filter((v) => known.has(v.base) && v.variant && v.variant !== v.base)
      .map((v) => ({ ...v, include: true }));
    const dropped = result.data.variations.length - usable.length;
    fillTable("variations", usable);
    el("qVariationsPanel").classList.remove("hidden");
    el("qBuildBtn").disabled = false;
    setStatus(
      status,
      `변형 ${usable.length}개 생성${dropped > 0 ? ` (원 용어와 안 맞는 ${dropped}개 제외)` : ""} — 쓸 변형만 체크하고 검색식을 조립하세요.`,
      "ok"
    );
  } catch (error) {
    setStatus(status, `변형 생성 실패: ${error.message}`, "error");
  } finally {
    el("qExpandBtn").disabled = false;
  }
}

// ---------- 레이어 3: 검색식 조립·검증 (코드) ----------

function collectSimilarGroupCodes() {
  const codes = [];
  (state.markVersion?.data?.goods || []).forEach((g) => {
    String(g.similarGroupCode || "")
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c && c !== "unknown")
      .forEach((c) => codes.push(c));
  });
  return [...new Set(codes)];
}

// ---------- 정교 검색식 10종 생성 (심사관 질의어 지침) ----------

async function seedExpertMockIfNeeded() {
  for (const [key, sample] of Object.entries(QUERY_EXPERT_MOCK)) {
    const existing = await getMockResponse(key);
    if (existing === null) await setMockResponse(key, sample);
  }
}

// 승인 1 확정본에서 표장 표기·발음 정보를 뽑아 프롬프트 입력으로 만든다
function markInputForExpert() {
  const mark = state.markVersion?.data || {};
  const texts = (mark.textElements || []).map((t) => ({ text: t.text, script: t.script, reading: t.reading }));
  return JSON.stringify({
    표기: texts,
    요부: mark.dominantPart || null,
    외국어의미: mark.foreignMeaning || []
  }, null, 2);
}

async function runExpertGenerate() {
  if (!state.markVersion) return;
  const status = el("qExpertStatus");
  el("qExpertBtn").disabled = true;
  setStatus(status, "정교 검색식 10종 생성 중... (개수 규칙이 엄격해 시간이 걸릴 수 있습니다)");
  try {
    const settings = await loadSettings();
    if (settings.mockMode) await seedExpertMockIfNeeded();
    state.syntax = await loadQuerySyntax();

    const runNote = el("qExpertNote").value.trim();
    const result = await callJson({
      promptKey: QUERY_EXPERT.promptKey,
      role: QUERY_EXPERT.role,
      schema: QUERY_EXPERT.schema,
      userContent: "출원상표 (승인 1 확정본):\n" + markInputForExpert(),
      runNote,
      temperature: 0.4
    });
    if (!result.ok) throw new Error(result.errors.join(" / "));

    const classCd = collectSimilarGroupCodes().join(state.syntax.operators?.or || "+");
    const exprs = (result.data.expressions || [])
      .slice()
      .sort((a, b) => (a.no || 0) - (b.no || 0));
    state.queries = exprs.map((e) => {
      const check = validateExpertExpression(e.no, e.query);
      return {
        label: `${e.no}. ${e.title}${e.note ? " — " + e.note : ""}`,
        query: e.query,
        classCd,
        purpose: "expert",
        exprNo: e.no,
        wordCount: check.wordCount,
        valid: check.valid,
        issues: check.issues
      };
    });
    // 분석 요약(발음·분절·자판·추천)을 참고로 저장
    state.expertMeta = {
      markKor: result.data.markKor, markEng: result.data.markEng,
      pronunciation: result.data.pronunciation, segmentation: result.data.segmentation,
      dvorak: result.data.dvorak, similarQueryRecommend: result.data.similarQueryRecommend,
      conceptSimilar: result.data.conceptSimilar
    };
    renderExpertMeta();
    renderQueries();
    el("qQueriesPanel").classList.remove("hidden");
    el("qApproveBtn").disabled = state.queries.length === 0;
    const invalid = state.queries.filter((q) => !q.valid).length;
    setStatus(
      status,
      `검색식 ${state.queries.length}종 생성${invalid > 0 ? ` — ${invalid}종 개수·기호 규칙 위반(빨간 표시). 직접 고치거나 다시 생성하세요` : " — 규칙 모두 통과"}.`,
      invalid > 0 ? "warn" : "ok"
    );
  } catch (error) {
    setStatus(status, `생성 실패: ${error.message}`, "error");
  } finally {
    el("qExpertBtn").disabled = !state.markVersion;
  }
}

function renderExpertMeta() {
  const box = el("qExpertMeta");
  const m = state.expertMeta;
  if (!m) { box.classList.add("hidden"); return; }
  const seg = m.segmentation || {};
  const lines = [
    m.pronunciation ? `발음: ${escapeHtmlQ(m.pronunciation)}` : "",
    (seg.front || seg.back) ? `분절: 앞 <code>${escapeHtmlQ(seg.front || "")}</code>(${seg.frontLen ?? "?"}글자) · 뒤 <code>${escapeHtmlQ(seg.back || "")}</code>(${seg.backLen ?? "?"}글자)${seg.slashNote ? " — " + escapeHtmlQ(seg.slashNote) : ""}` : "",
    m.dvorak ? `두벌식 자판: <code>${escapeHtmlQ(m.dvorak)}</code>` : "",
    m.similarQueryRecommend ? `유사질의어 란 추천: <code>${escapeHtmlQ(m.similarQueryRecommend)}</code>` : "",
    m.conceptSimilar ? `관념 유사(별건 검토): ${escapeHtmlQ(m.conceptSimilar)}` : ""
  ].filter(Boolean);
  box.innerHTML = lines.join("<br>");
  box.classList.toggle("hidden", lines.length === 0);
}

function escapeHtmlQ(text) {
  const div = document.createElement("div");
  div.textContent = String(text ?? "");
  return div.innerHTML;
}

async function runBuild() {
  const status = el("qBuildStatus");
  const terms = readTable("terms");
  if (terms.length === 0) {
    setStatus(status, "용어가 없습니다.", "error");
    return;
  }
  state.syntax = await loadQuerySyntax();
  state.queries = buildQueries(state.syntax, {
    terms,
    variations: readTable("variations"),
    similarGroupCodes: collectSimilarGroupCodes()
  });
  renderQueries();
  el("qQueriesPanel").classList.remove("hidden");
  el("qApproveBtn").disabled = state.queries.length === 0;
  const invalid = state.queries.filter((q) => !q.valid).length;
  setStatus(
    status,
    state.queries.length === 0
      ? "조립된 검색식이 없습니다. 용어를 확인해 주세요."
      : `검색식 ${state.queries.length}건 조립 (문법: ${state.syntax.system})${invalid > 0 ? ` — ${invalid}건 검증 실패, 수정 필요` : ""}. 직접 수정할 수 있습니다.`,
    state.queries.length === 0 ? "error" : invalid > 0 ? "warn" : "ok"
  );
}

function renderQueries() {
  const list = el("qQueryList");
  list.innerHTML = "";
  state.queries.forEach((item, index) => {
    const div = document.createElement("div");
    div.className = "query-item";

    const head = document.createElement("div");
    head.className = "query-head";
    const label = document.createElement("span");
    label.className = "query-label";
    label.textContent = item.label;
    const chip = document.createElement("span");
    const chipText = (it) => {
      if (!it.valid) return "검증 실패";
      if (!it.exprNo) return "검증 통과";
      if (it.exprNo >= 7 && it.exprNo <= 9) return "✓ 교차 10+10";
      return `✓ ${it.wordCount ?? "?"}단어`;
    };
    chip.className = "approve-chip" + (item.valid ? " done" : "");
    chip.textContent = chipText(item);
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "row-del-btn";
    delBtn.textContent = "✕";
    delBtn.title = "이 검색식 제거";
    delBtn.addEventListener("click", () => {
      state.queries.splice(index, 1);
      renderQueries();
      el("qApproveBtn").disabled = state.queries.length === 0;
    });
    head.appendChild(label);
    head.appendChild(chip);
    head.appendChild(delBtn);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "query-input";
    input.value = item.query;
    input.addEventListener("input", () => {
      item.query = input.value;
      // 정교 검색식(exprNo)이면 개수·기호 규칙으로, 아니면 기본 문법 검증
      const check = item.exprNo
        ? validateExpertExpression(item.exprNo, item.query)
        : validateQuery(state.syntax, item.query);
      item.valid = check.valid;
      item.issues = check.issues;
      if ("wordCount" in check) item.wordCount = check.wordCount;
      chip.className = "approve-chip" + (item.valid ? " done" : "");
      chip.textContent = chipText(item);
      issues.textContent = item.issues.join(" ");
      issues.classList.toggle("hidden", item.issues.length === 0);
    });

    const issues = document.createElement("div");
    issues.className = "query-issues";
    issues.textContent = (item.issues || []).join(" ");
    issues.classList.toggle("hidden", (item.issues || []).length === 0);

    div.appendChild(head);
    div.appendChild(input);
    if (item.classCd) {
      const codeLine = document.createElement("div");
      codeLine.className = "query-codes";
      codeLine.textContent = `유사군코드 제한 (ClassCd): ${item.classCd}`;
      div.appendChild(codeLine);
    }
    div.appendChild(issues);
    list.appendChild(div);
  });
}

// ---------- 승인 2 (검색 준비서 버전 고정) [설계 원칙 3·4] ----------

async function approveBrief() {
  const status = el("qApproveStatus");
  if (!state.caseId || !state.markVersion) {
    setStatus(status, "출원건과 승인 1이 필요합니다.", "error");
    return;
  }
  const terms = readTable("terms");
  const queries = state.queries.filter((q) => q.query.trim());
  if (queries.length === 0) {
    setStatus(status, "검색식이 최소 하나는 있어야 확정할 수 있습니다.", "error");
    return;
  }
  const invalid = queries.filter((q) => !q.valid).length;
  if (invalid > 0) {
    const proceed = window.confirm(
      `검증에 실패한 검색식이 ${invalid}건 있습니다.\n그대로 확정할까요? (나중에 새 버전으로 수정할 수 있습니다)`
    );
    if (!proceed) return;
  }
  try {
    const data = {
      terms,
      variations: readTable("variations"),
      similarGroupCodes: collectSimilarGroupCodes(),
      queries: queries.map(({ label, query, classCd, purpose, valid, exprNo }) => ({ label, query, classCd, purpose, valid, exprNo })),
      expertMeta: state.expertMeta || null,
      syntaxSystem: state.syntax?.system || null
    };
    const version = await addVersion("searchBriefs", state.caseId, data, {
      approvedAt: new Date().toISOString(),
      markVersionId: state.markVersion.id // 어느 승인 1 기준인지 기록 [설계 원칙 4]
    });
    await touchCase(state.caseId, { approvedSearchBriefId: version.id });
    setStatus(status, `승인 2 완료 — v${version.seq} 로 확정했습니다. 검색 에이전트(모듈 3)에서 이 검색식들을 사용합니다.`, "ok");
    await renderBriefVersions();
  } catch (error) {
    setStatus(status, `확정 실패: ${error.message}`, "error");
  }
}

// ---------- 버전 이력 ----------

async function renderBriefVersions() {
  const container = el("qVersionList");
  if (!state.caseId) {
    container.textContent = "아직 확정된 버전이 없습니다.";
    return;
  }
  const caseRecord = await get("cases", state.caseId);
  const versions = (await getAllByCase("searchBriefs", state.caseId)).sort((a, b) => b.seq - a.seq);
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
    current.className = "approve-chip" + (caseRecord?.approvedSearchBriefId === version.id ? " done" : "");
    current.textContent = caseRecord?.approvedSearchBriefId === version.id ? "현재 확정본" : "이전 버전";
    const loadBtn = document.createElement("button");
    loadBtn.type = "button";
    loadBtn.className = "btn";
    loadBtn.textContent = "불러오기";
    loadBtn.addEventListener("click", async () => {
      fillTable("terms", version.data.terms || []);
      fillTable("variations", version.data.variations || []);
      state.syntax = await loadQuerySyntax();
      state.expertMeta = version.data.expertMeta || null;
      state.queries = (version.data.queries || []).map((q) => ({
        ...q,
        // 정교 검색식이면 개수·기호 규칙으로 재검증, 아니면 기본 문법 검증
        ...(q.exprNo ? validateExpertExpression(q.exprNo, q.query) : validateQuery(state.syntax, q.query))
      }));
      renderExpertMeta();
      renderQueries();
      ["qTermsPanel", "qVariationsPanel", "qQueriesPanel"].forEach((id) => el(id).classList.remove("hidden"));
      el("qExpandBtn").disabled = false;
      el("qBuildBtn").disabled = false;
      el("qApproveBtn").disabled = state.queries.length === 0;
      setStatus(el("qApproveStatus"), `v${version.seq} 내용을 불러왔습니다. 수정 후 [승인 2]를 누르면 새 버전이 됩니다.`, "ok");
    });
    item.appendChild(tag);
    item.appendChild(date);
    item.appendChild(current);
    item.appendChild(loadBtn);
    container.appendChild(item);
  });
}

// ---------- 초기화 ----------

export async function initQuery() {
  el("qCaseSelect").addEventListener("change", () => void onCaseChange());
  el("qExpertBtn").addEventListener("click", () => void runExpertGenerate());
  el("qTermsBtn").addEventListener("click", () => void runTerms());
  el("qExpandBtn").addEventListener("click", () => void runExpand());
  el("qBuildBtn").addEventListener("click", () => void runBuild());
  el("qApproveBtn").addEventListener("click", () => void approveBrief());
  document.querySelectorAll(".q-add-row-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const defKey = btn.dataset.add;
      const tbody = el(TABLE_DEFS[defKey].tbody).querySelector("tbody");
      tbody.appendChild(buildRow(defKey, { ...TABLE_DEFS[defKey].empty }));
    });
  });
  await refreshQueryCases();
}
