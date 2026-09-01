// TRADEMARK 통합 대시보드 — 1단계: 연결 상태 + 출원건 관리 (IndexedDB 동작 확인)
// 모듈 1(출원상표 분석)은 2단계에서 이 파일에 이어 붙인다.

import { STORAGE_KEYS } from "../shared/constants.js";
import { loadSettings } from "../shared/settings.js";
import { fetchAvailableModels } from "../shared/llm.js";
import { createCase, listCases, deleteCaseCascade } from "../shared/db.js";
import { initAnalysis, refreshAnalysisCases } from "./analysis.js";
import { initNotice, refreshNoticeCases } from "./notice.js";

const el = (id) => document.getElementById(id);

const state = {
  settings: null,
  activeView: "home"
};

function setStatus(target, text, tone = "") {
  target.textContent = text;
  target.className = "status" + (tone ? ` ${tone}` : "");
}

// ---------- 뷰 전환 ----------

function switchView(view) {
  state.activeView = view;
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("hidden", section.id !== `view-${view}`);
  });
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  // 화면 이동 시 출원건 목록 최신화
  if (view === "analysis") void refreshAnalysisCases();
  if (view === "notice") void refreshNoticeCases();
}

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!btn.disabled) switchView(btn.dataset.view);
  });
});

// ---------- 연결 상태 ----------

function renderSettingsSummary() {
  const s = state.settings;
  const summary = el("settingsSummary");
  const lines = [];
  lines.push(`API 주소: ${s.baseUrl ? `<code>${escapeHtml(s.baseUrl)}</code>` : "<code>미설정</code>"}`);
  lines.push(`API 방식: <code>${s.apiStyle}</code> · 기본 모델: <code>${escapeHtml(s.defaultModel)}</code>`);
  lines.push(`목 모드: <code>${s.mockMode ? "켜짐" : "꺼짐"}</code> · 이미지 입력: <code>${s.imageInput ? "사용" : "미사용"}</code>`);
  summary.innerHTML = lines.join("<br>");
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = String(text ?? "");
  return div.innerHTML;
}

async function testConnection() {
  const badge = el("connBadge");
  const listEl = el("modelList");
  setStatus(el("connStatus"), "모델 목록을 조회하는 중...");
  el("testConnBtn").disabled = true;
  listEl.innerHTML = "";
  try {
    const models = await fetchAvailableModels();
    setStatus(el("connStatus"), `연결 성공 — 모델 ${models.length}개`, "ok");
    badge.textContent = "연결됨";
    badge.className = "conn-badge ok";
    models.slice(0, 30).forEach((model) => {
      const li = document.createElement("li");
      li.textContent = model.label;
      listEl.appendChild(li);
    });
  } catch (error) {
    setStatus(el("connStatus"), `연결 실패: ${error.message}`, "error");
    badge.textContent = "연결 실패";
    badge.className = "conn-badge error";
  } finally {
    el("testConnBtn").disabled = false;
  }
}

// ---------- 출원건 관리 ----------

async function renderCaseTable() {
  const body = el("caseTableBody");
  body.innerHTML = "";
  const cases = await listCases();
  if (cases.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.textContent = "등록된 출원건이 없습니다.";
    td.style.color = "var(--muted)";
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }
  cases.forEach((item) => {
    const tr = document.createElement("tr");

    const idTd = document.createElement("td");
    idTd.textContent = item.id;
    const titleTd = document.createElement("td");
    titleTd.textContent = item.title || "—";

    const a1Td = document.createElement("td");
    const a1 = document.createElement("span");
    a1.className = "approve-chip" + (item.approvedMarkVersionId ? " done" : "");
    a1.textContent = item.approvedMarkVersionId ? "확정" : "미확정";
    a1Td.appendChild(a1);

    const a2Td = document.createElement("td");
    const a2 = document.createElement("span");
    a2.className = "approve-chip" + (item.approvedSearchBriefId ? " done" : "");
    a2.textContent = item.approvedSearchBriefId ? "확정" : "미확정";
    a2Td.appendChild(a2);

    const dateTd = document.createElement("td");
    dateTd.textContent = (item.updatedAt || "").slice(0, 10);

    const actionTd = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn danger";
    delBtn.textContent = "삭제";
    delBtn.addEventListener("click", () => void onDeleteCase(item.id));
    actionTd.appendChild(delBtn);

    [idTd, titleTd, a1Td, a2Td, dateTd, actionTd].forEach((td) => tr.appendChild(td));
    body.appendChild(tr);
  });
}

async function onCreateCase() {
  const caseId = el("newCaseId").value.trim();
  const title = el("newCaseTitle").value.trim();
  if (!caseId) {
    setStatus(el("caseStatus"), "출원번호를 입력해 주세요.", "error");
    return;
  }
  try {
    await createCase({ caseId, title });
    await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_CASE_ID]: caseId });
    el("newCaseId").value = "";
    el("newCaseTitle").value = "";
    setStatus(el("caseStatus"), `출원건 ${caseId} 을(를) 생성했습니다.`, "ok");
    await renderCaseTable();
    await refreshAnalysisCases();
  } catch (error) {
    setStatus(el("caseStatus"), `생성 실패: ${error.message}`, "error");
  }
}

async function onDeleteCase(caseId) {
  // 관련 산출물이 모두 지워지므로 반드시 확인을 받는다
  const confirmed = window.confirm(
    `출원건 ${caseId} 과 관련된 분석·검색·통지서 데이터가 모두 삭제됩니다.\n삭제할까요? (되돌릴 수 없음)`
  );
  if (!confirmed) return;
  try {
    await deleteCaseCascade(caseId);
    setStatus(el("caseStatus"), `출원건 ${caseId} 을(를) 삭제했습니다.`, "ok");
    await renderCaseTable();
    await refreshAnalysisCases();
  } catch (error) {
    setStatus(el("caseStatus"), `삭제 실패: ${error.message}`, "error");
  }
}

// ---------- 초기화 ----------

async function initialize() {
  state.settings = await loadSettings();
  renderSettingsSummary();
  await renderCaseTable();
  await initAnalysis();
  await initNotice();

  // URL 해시로 초기 뷰 지정 가능 (#review, #notice 등 — 해당 모듈 구현 후 활성화)
  const hash = location.hash.replace("#", "");
  if (hash && document.getElementById(`view-${hash}`)) switchView(hash);
}

el("testConnBtn").addEventListener("click", () => void testConnection());
el("createCaseBtn").addEventListener("click", () => void onCreateCase());
el("newCaseId").addEventListener("keydown", (event) => {
  if (event.key === "Enter") void onCreateCase();
});

void initialize();
