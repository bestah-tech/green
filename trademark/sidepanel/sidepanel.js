// 모듈 3 — 검색 에이전트 사이드패널 (1차: 수집·평가)
//
// 흐름: KIPRIS 탭에서 심사관이 검색 실행 → [수집] 으로 결과 DOM 파싱 →
//       체크한 항목을 후보(P0001~)로 저장 → 후보별 칭호·외관·관념 유사도 평가(LLM/목).
// 지정상품 유사군 비교는 코드가 담당(승인 1의 유사군코드 ↔ 후보의 분류 텍스트 대조).
// 자동 반복 루프(검색식 자동 실행)는 모듈 2 승인 2 이후 단계에서 추가한다. [설계 원칙 3]

import { STORAGE_KEYS } from "../shared/constants.js";
import { loadSettings } from "../shared/settings.js";
import { callJson } from "../shared/llm.js";
import { listCases, get, put, nextId, getAllByCase, setMockResponse, getMockResponse } from "../shared/db.js";
import { CANDIDATE_SCORE, SCORE_MOCK } from "./score-prompts.js";

const el = (id) => document.getElementById(id);

const state = {
  settings: null,
  caseId: "",
  markVersion: null,   // 승인 1 확정본
  tabId: null,
  tabOk: false,
  collected: [],       // 수집됐지만 아직 저장 안 된 항목
  selectors: null
};

function setStatus(target, text, tone = "") {
  target.textContent = text;
  target.className = "status" + (tone ? ` ${tone}` : "");
}

// ---------- 탭 조건 확인 ----------

async function loadSelectors() {
  if (!state.selectors) {
    const response = await fetch(chrome.runtime.getURL("config/selectors.json"));
    state.selectors = await response.json();
  }
  return state.selectors;
}

async function checkTab() {
  const badge = el("tabBadge");
  try {
    const selectors = await loadSelectors();
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const url = String(tab?.url || "");
    const matched = (selectors.urlPatterns || []).some((pattern) => url.includes(pattern));
    state.tabId = tab?.id ?? null;
    state.tabOk = matched;
    badge.textContent = matched ? "검색시스템 탭" : "탭 조건 미충족";
    badge.className = "tab-badge" + (matched ? " ok" : " error");
    el("collectBtn").disabled = !matched;
    el("captureBtn").disabled = !matched;
  } catch (error) {
    badge.textContent = "탭 확인 실패";
    badge.className = "tab-badge error";
  }
}

// ---------- 출원건 ----------

async function refreshCases() {
  const select = el("spCaseSelect");
  const cases = await listCases();
  const saved = await chrome.storage.local.get(STORAGE_KEYS.ACTIVE_CASE_ID);
  const active = state.caseId || saved[STORAGE_KEYS.ACTIVE_CASE_ID] || "";
  select.innerHTML = "";
  if (cases.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "— 대시보드에서 출원건을 먼저 생성하세요 —";
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
  await renderCandidates();
}

async function loadMarkVersion() {
  state.markVersion = null;
  if (!state.caseId) {
    setStatus(el("spCaseState"), "출원건이 없습니다.");
    return;
  }
  const caseRecord = await get("cases", state.caseId);
  if (caseRecord?.approvedMarkVersionId) {
    state.markVersion = await get("markVersions", caseRecord.approvedMarkVersionId);
    setStatus(el("spCaseState"), `승인 1 확정 (v${state.markVersion?.seq}) — 유사도 평가 가능`, "ok");
  } else {
    setStatus(el("spCaseState"), "승인 1 미확정 — 수집·저장은 가능하지만 유사도 평가는 승인 1 이후에 가능합니다.", "warn");
  }
}

// ---------- content script 통신 ----------

async function sendToTab(message) {
  if (!state.tabId) throw new Error("검색시스템 탭을 찾을 수 없습니다.");
  try {
    return await chrome.tabs.sendMessage(state.tabId, message);
  } catch (error) {
    throw new Error("페이지와 연결할 수 없습니다. KIPRIS 탭을 새로고침(F5)한 뒤 다시 시도해 주세요.");
  }
}

// ---------- ① 검색결과 수집 ----------

async function collectResults() {
  setStatus(el("collectStatus"), "수집 중...");
  el("collectBtn").disabled = true;
  try {
    const selectors = await loadSelectors();
    const response = await sendToTab({ type: "TM_COLLECT_RESULTS", selectors });
    if (!response?.ok) throw new Error(response?.error || "수집 실패");
    state.collected = response.results || [];
    renderCollected();
    const mode = state.collected[0]?.source === "selector" ? "셀렉터" : "자동 인식";
    setStatus(
      el("collectStatus"),
      state.collected.length > 0
        ? `${state.collected.length}건 수집 (${mode} 방식). 후보로 저장할 항목을 체크하세요.`
        : "수집된 결과가 없습니다. 검색결과가 화면에 보이는 상태인지 확인해 주세요.",
      state.collected.length > 0 ? "ok" : "warn"
    );
  } catch (error) {
    setStatus(el("collectStatus"), error.message, "error");
  } finally {
    el("collectBtn").disabled = !state.tabOk;
  }
}

function renderCollected() {
  const list = el("collectedList");
  list.innerHTML = "";
  el("saveRow").classList.toggle("hidden", state.collected.length === 0);
  state.collected.forEach((item, index) => {
    const div = document.createElement("div");
    div.className = "collected-item";
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.index = String(index);
    const body = document.createElement("div");
    const head = document.createElement("div");
    head.className = "ci-head";
    head.textContent = [item.applicationNumber || "번호 미인식", item.markName].filter(Boolean).join(" · ");
    const raw = document.createElement("div");
    raw.className = "ci-raw";
    raw.textContent = item.rawText;
    body.appendChild(head);
    body.appendChild(raw);
    label.appendChild(checkbox);
    label.appendChild(body);
    div.appendChild(label);
    list.appendChild(div);
  });
}

async function saveCheckedCandidates() {
  if (!state.caseId) {
    setStatus(el("collectStatus"), "출원건을 먼저 선택해 주세요.", "error");
    return;
  }
  const checked = [...el("collectedList").querySelectorAll("input:checked")]
    .map((input) => state.collected[Number(input.dataset.index)])
    .filter(Boolean);
  if (checked.length === 0) {
    setStatus(el("collectStatus"), "저장할 항목을 체크해 주세요.", "warn");
    return;
  }
  for (const item of checked) {
    const label = await nextId(state.caseId, "P");
    await put("candidates", {
      id: `${state.caseId}:${label}`,
      caseId: state.caseId,
      label,
      applicationNumber: item.applicationNumber || "unknown",
      markName: item.markName || "",
      applicant: item.applicant || "",
      status: item.status || "",
      goodsClasses: item.goodsClasses || "",
      rawText: item.rawText,
      collectedFrom: item.source,
      collectedAt: new Date().toISOString(),
      score: null,
      decision: "review_required" // 종료 상태는 항상 검토 필요 [지시서 모듈 3]
    });
  }
  setStatus(el("collectStatus"), `${checked.length}건을 후보로 저장했습니다.`, "ok");
  state.collected = [];
  renderCollected();
  await renderCandidates();
}

// ---------- ② 후보 목록 · 유사도 평가 ----------

// 지정상품 비교(코드 담당): 승인 1 의 류 목록과 후보의 분류 텍스트에 겹치는 류가 있는지
function compareGoodsClasses(markVersion, candidate) {
  const myClasses = new Set(
    (markVersion?.data?.goods || [])
      .map((g) => Number(g.class))
      .filter((n) => Number.isFinite(n))
  );
  const candClasses = String(candidate.goodsClasses || candidate.rawText || "")
    .match(/\d{1,2}/g) || [];
  const overlap = [...new Set(candClasses.map(Number))].filter((n) => myClasses.has(n));
  if (myClasses.size === 0 || candClasses.length === 0) return { result: "unknown", overlap: [] };
  return { result: overlap.length > 0 ? "겹침" : "안겹침", overlap };
}

async function scoreCandidate(candidate) {
  if (!state.markVersion) throw new Error("승인 1이 확정되어야 유사도 평가를 실행할 수 있습니다.");
  state.settings = await loadSettings();
  if (state.settings.mockMode) {
    const existing = await getMockResponse(CANDIDATE_SCORE.promptKey);
    if (existing === null) await setMockResponse(CANDIDATE_SCORE.promptKey, SCORE_MOCK);
  }
  const mark = state.markVersion.data;
  const userContent = [
    "## 출원상표 (승인 1 확정본)",
    JSON.stringify({
      markType: mark.markType,
      textElements: mark.textElements,
      dominantPart: mark.dominantPart,
      foreignMeaning: mark.foreignMeaning
    }, null, 2),
    "",
    "## 선행상표 후보",
    JSON.stringify({
      applicationNumber: candidate.applicationNumber,
      markName: candidate.markName || "(미상 — 아래 원문에서 파악)",
      rawText: candidate.rawText
    }, null, 2)
  ].join("\n");

  const result = await callJson({
    promptKey: CANDIDATE_SCORE.promptKey,
    role: CANDIDATE_SCORE.role,
    schema: CANDIDATE_SCORE.schema,
    userContent
  });
  if (!result.ok) throw new Error(`평가 실패: ${result.errors.join(" / ")}`);

  const goodsCheck = compareGoodsClasses(state.markVersion, candidate);
  const updated = {
    ...candidate,
    score: result.data,
    goodsCheck,
    scoredAt: new Date().toISOString(),
    markVersionId: state.markVersion.id // 어느 버전 기준 평가인지 기록 [설계 원칙 4]
  };
  await put("candidates", updated);
  return updated;
}

async function renderCandidates() {
  const list = el("candidateList");
  if (!state.caseId) {
    list.textContent = "저장된 후보가 없습니다.";
    return;
  }
  const candidates = (await getAllByCase("candidates", state.caseId))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (candidates.length === 0) {
    list.textContent = "저장된 후보가 없습니다.";
    return;
  }
  list.innerHTML = "";
  candidates.forEach((candidate) => {
    const item = document.createElement("div");
    item.className = "candidate-item";

    const head = document.createElement("div");
    head.className = "cand-head";
    const title = document.createElement("span");
    const label = document.createElement("span");
    label.className = "cand-label";
    label.textContent = candidate.label;
    title.appendChild(label);
    title.appendChild(document.createTextNode(
      ` ${candidate.applicationNumber}${candidate.markName ? " · " + candidate.markName : ""}`
    ));
    const scoreBtn = document.createElement("button");
    scoreBtn.type = "button";
    scoreBtn.className = "btn mini";
    scoreBtn.textContent = candidate.score ? "재평가" : "유사도 평가";
    scoreBtn.disabled = !state.markVersion;
    scoreBtn.addEventListener("click", async () => {
      scoreBtn.disabled = true;
      scoreBtn.textContent = "평가 중...";
      try {
        await scoreCandidate(candidate);
        await renderCandidates();
      } catch (error) {
        scoreBtn.textContent = "실패 — 재시도";
        scoreBtn.title = error.message;
        scoreBtn.disabled = false;
        alert(error.message);
      }
    });
    head.appendChild(title);
    head.appendChild(scoreBtn);
    item.appendChild(head);

    if (candidate.score) {
      const scores = document.createElement("div");
      scores.className = "score-row";
      [
        ["칭호", candidate.score.pronunciation],
        ["외관", candidate.score.appearance],
        ["관념", candidate.score.concept]
      ].forEach(([name, part]) => {
        const chip = document.createElement("span");
        chip.className = "score-chip" + (part.score >= 76 ? " high" : "");
        chip.textContent = `${name} ${part.score}`;
        scores.appendChild(chip);
      });
      const goodsChip = document.createElement("span");
      goodsChip.className = "score-chip" + (candidate.goodsCheck?.result === "겹침" ? " high" : "");
      goodsChip.textContent = `류 ${candidate.goodsCheck?.result || "unknown"}` +
        (candidate.goodsCheck?.overlap?.length ? ` (${candidate.goodsCheck.overlap.join(",")})` : "");
      scores.appendChild(goodsChip);
      item.appendChild(scores);

      const reason = document.createElement("div");
      reason.className = "score-reason";
      reason.textContent = [
        `칭호: ${candidate.score.pronunciation.reasons.join(" ")}`,
        `외관: ${candidate.score.appearance.reasons.join(" ")}`,
        `관념: ${candidate.score.concept.reasons.join(" ")}`
      ].join("\n");
      item.appendChild(reason);
    }

    list.appendChild(item);
  });
}

// ---------- 화면 구조 캡처 (개발용) ----------

async function captureStructure() {
  setStatus(el("captureStatus"), "캡처 중...");
  try {
    const response = await sendToTab({ type: "TM_CAPTURE_STRUCTURE" });
    if (!response?.ok) throw new Error(response?.error || "캡처 실패");
    const out = el("captureOut");
    out.value = JSON.stringify(response.capture, null, 2);
    out.classList.remove("hidden");
    el("copyCaptureBtn").classList.remove("hidden");
    setStatus(el("captureStatus"), `캡처 완료 (감지된 항목 ${response.capture.itemCount}건). 내용을 복사해 전달해 주세요.`, "ok");
  } catch (error) {
    setStatus(el("captureStatus"), error.message, "error");
  }
}

// ---------- 초기화 ----------

async function initialize() {
  state.settings = await loadSettings();
  await checkTab();
  await refreshCases();

  el("spCaseSelect").addEventListener("change", async () => {
    state.caseId = el("spCaseSelect").value;
    await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_CASE_ID]: state.caseId });
    await loadMarkVersion();
    await renderCandidates();
  });
  el("collectBtn").addEventListener("click", () => void collectResults());
  el("saveCandidatesBtn").addEventListener("click", () => void saveCheckedCandidates());
  el("captureBtn").addEventListener("click", () => void captureStructure());
  el("copyCaptureBtn").addEventListener("click", async () => {
    await navigator.clipboard.writeText(el("captureOut").value);
    setStatus(el("captureStatus"), "클립보드에 복사했습니다.", "ok");
  });

  // 탭 전환 감지
  chrome.tabs.onActivated?.addListener(() => void checkTab());
  chrome.tabs.onUpdated?.addListener((_tabId, changeInfo) => {
    if (changeInfo.status === "complete") void checkTab();
  });
}

void initialize();
