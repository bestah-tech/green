// 모듈 5 — 통지서 작성 (최소판) [지시서 개발 순서 3]
//
// - 조문별 판단 문구 자산: 사용 상황·승인 상태 보관, 승인된 문구만 초안에 사용 가능 [근거 제한]
// - 초안 조립은 코드가 한다 (LLM 미사용). 치환 변수: 출원번호·표장·지정상품·거절이유
// - 저장 시 notices 에 버전으로 쌓이고, HWPX 다운로드는 shared/hwpx.js 가 담당
// - 대화형 AI 수정·근거 칩·재검토 표시는 7단계에서 완성

import { get, put, getAll, remove, addVersion, getAllByCase, listCases } from "../shared/db.js";
import { STORAGE_KEYS } from "../shared/constants.js";
import { downloadHwpx } from "../shared/hwpx.js";

const el = (id) => document.getElementById(id);

// 조문 목록 (지시서: 33조 1항 1~7호, 34조 1항 각호 중 주요호)
const ARTICLES = [
  "상표법 제33조 제1항 제1호", "상표법 제33조 제1항 제2호", "상표법 제33조 제1항 제3호",
  "상표법 제33조 제1항 제4호", "상표법 제33조 제1항 제5호", "상표법 제33조 제1항 제6호",
  "상표법 제33조 제1항 제7호",
  "상표법 제34조 제1항 제7호", "상표법 제34조 제1항 제9호", "상표법 제34조 제1항 제11호",
  "상표법 제34조 제1항 제12호", "상표법 제34조 제1항 제13호"
];

// 기본 제공 표준형 문구 (씨앗) — 승인 전이므로 심사관이 검토·승인해야 초안에 쓸 수 있다
const SEED_PHRASES = [
  {
    id: "seed_33_1_1",
    article: "상표법 제33조 제1항 제1호",
    title: "보통명칭 표준형",
    text: "이 출원상표는 그 지정상품의 보통명칭을 보통으로 사용하는 방법으로 표시한 표장만으로 된 상표이므로 상표법 제33조 제1항 제1호에 해당합니다.",
    usage: "표장 전체가 지정상품의 보통명칭인 경우"
  },
  {
    id: "seed_33_1_3",
    article: "상표법 제33조 제1항 제3호",
    title: "기술적 표장 표준형",
    text: "이 출원상표는 그 지정상품의 품질·효능·용도 등의 성질을 직접적으로 표시하는 표장만으로 된 상표이므로 상표법 제33조 제1항 제3호에 해당합니다.",
    usage: "표장이 지정상품의 성질을 직접 기술하는 경우"
  },
  {
    id: "seed_33_1_6",
    article: "상표법 제33조 제1항 제6호",
    title: "간단하고 흔한 표장 표준형",
    text: "이 출원상표는 간단하고 흔히 있는 표장만으로 된 상표이므로 상표법 제33조 제1항 제6호에 해당합니다.",
    usage: "한두 글자·단순 도형 등 간단하고 흔한 표장"
  },
  {
    id: "seed_33_1_7",
    article: "상표법 제33조 제1항 제7호",
    title: "기타 식별력 없음 표준형",
    text: "이 출원상표는 수요자가 누구의 업무에 관련된 상품을 표시하는 것인가를 식별할 수 없는 상표이므로 상표법 제33조 제1항 제7호에 해당합니다.",
    usage: "1~6호 외의 사유로 식별력이 인정되지 않는 경우"
  },
  {
    id: "seed_34_1_7",
    article: "상표법 제34조 제1항 제7호",
    title: "선등록상표와 유사 표준형",
    text: "이 출원상표는 선등록상표와 그 표장 및 지정상품이 동일하거나 유사하여 상표법 제34조 제1항 제7호에 해당합니다. (인용상표의 등록번호·표장·지정상품은 심사관이 채택한 선행상표 정보로 특정하여 기재합니다.)",
    usage: "선등록상표 인용 시 — 7단계에서 채택 후보 연동 예정"
  }
];

const state = {
  caseId: "",
  caseRecord: null,
  markVersion: null,
  grounds: [],       // [{ article, phraseId, phraseTitle, phraseText }]
  draftReady: false
};

function setStatus(target, text, tone = "") {
  target.textContent = text;
  target.className = "status" + (tone ? ` ${tone}` : "");
}

// ---------- 문구 자산 ----------

async function seedPhrasesIfNeeded() {
  for (const seed of SEED_PHRASES) {
    const existing = await get("phraseAssets", seed.id);
    if (!existing) {
      await put("phraseAssets", {
        ...seed,
        approved: false,
        source: "기본 제공",
        createdAt: new Date().toISOString()
      });
    }
  }
}

async function listPhrases() {
  const all = await getAll("phraseAssets");
  return all.sort((a, b) => a.article.localeCompare(b.article, "ko") || (a.createdAt || "").localeCompare(b.createdAt || ""));
}

async function renderAssetList() {
  const container = el("ntAssetList");
  const phrases = await listPhrases();
  container.innerHTML = "";
  if (phrases.length === 0) {
    container.textContent = "등록된 문구가 없습니다.";
    return;
  }
  phrases.forEach((phrase) => {
    const item = document.createElement("div");
    item.className = "asset-item";

    const head = document.createElement("div");
    head.className = "asset-head";
    const title = document.createElement("span");
    title.innerHTML = `<strong>${escapeText(phrase.article)}</strong> · ${escapeText(phrase.title)}`;
    const chips = document.createElement("span");
    chips.className = "row";
    const approveChip = document.createElement("span");
    approveChip.className = "approve-chip" + (phrase.approved ? " done" : "");
    approveChip.textContent = phrase.approved ? "승인됨" : "미승인";
    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "btn mini-btn";
    toggleBtn.textContent = phrase.approved ? "승인 해제" : "승인";
    toggleBtn.addEventListener("click", async () => {
      await put("phraseAssets", { ...phrase, approved: !phrase.approved });
      await renderAssetList();
      await renderPhraseSelect();
    });
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn mini-btn danger";
    delBtn.textContent = "삭제";
    delBtn.addEventListener("click", async () => {
      if (!window.confirm(`문구 "${phrase.title}" 을(를) 삭제할까요?`)) return;
      await remove("phraseAssets", phrase.id);
      await renderAssetList();
      await renderPhraseSelect();
    });
    chips.appendChild(approveChip);
    chips.appendChild(toggleBtn);
    chips.appendChild(delBtn);
    head.appendChild(title);
    head.appendChild(chips);

    const body = document.createElement("div");
    body.className = "asset-body";
    body.textContent = phrase.text;
    const usage = document.createElement("div");
    usage.className = "asset-usage";
    usage.textContent = phrase.usage ? `사용 상황: ${phrase.usage} (${phrase.source})` : `(${phrase.source})`;

    item.appendChild(head);
    item.appendChild(body);
    item.appendChild(usage);
    container.appendChild(item);
  });
}

function escapeText(text) {
  const div = document.createElement("div");
  div.textContent = String(text ?? "");
  return div.innerHTML;
}

async function addAsset() {
  const article = el("ntAssetArticle").value;
  const title = el("ntAssetTitle").value.trim();
  const text = el("ntAssetText").value.trim();
  const usage = el("ntAssetUsage").value.trim();
  if (!title || !text) {
    setStatus(el("ntAssetStatus"), "문구 제목과 본문을 입력해 주세요.", "error");
    return;
  }
  await put("phraseAssets", {
    id: `ph_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    article, title, text, usage,
    approved: true, // 심사관이 직접 등록한 문구는 등록 즉시 채택된 것으로 본다
    source: "심사관 등록",
    createdAt: new Date().toISOString()
  });
  el("ntAssetTitle").value = "";
  el("ntAssetText").value = "";
  el("ntAssetUsage").value = "";
  setStatus(el("ntAssetStatus"), "문구를 등록했습니다 (승인 상태로 저장).", "ok");
  await renderAssetList();
  await renderPhraseSelect();
}

// ---------- 거절이유 구성 ----------

function renderArticleSelects() {
  [el("ntArticleSelect"), el("ntAssetArticle")].forEach((select) => {
    select.innerHTML = "";
    ARTICLES.forEach((article) => {
      const option = document.createElement("option");
      option.value = article;
      option.textContent = article;
      select.appendChild(option);
    });
  });
}

async function renderPhraseSelect() {
  const article = el("ntArticleSelect").value;
  const select = el("ntPhraseSelect");
  const phrases = (await listPhrases()).filter((p) => p.article === article && p.approved);
  select.innerHTML = "";
  if (phrases.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "— 이 조문에 승인된 문구가 없습니다 —";
    select.appendChild(option);
  } else {
    phrases.forEach((phrase) => {
      const option = document.createElement("option");
      option.value = phrase.id;
      option.textContent = phrase.title;
      select.appendChild(option);
    });
  }
}

async function addGround() {
  const phraseId = el("ntPhraseSelect").value;
  if (!phraseId) {
    setStatus(el("ntDraftStatus"), "승인된 문구를 먼저 선택(또는 아래에서 등록·승인)해 주세요.", "error");
    return;
  }
  const phrase = await get("phraseAssets", phraseId);
  if (!phrase || !phrase.approved) {
    setStatus(el("ntDraftStatus"), "승인되지 않은 문구는 사용할 수 없습니다.", "error");
    return;
  }
  state.grounds.push({
    article: phrase.article,
    phraseId: phrase.id,
    phraseTitle: phrase.title,
    phraseText: phrase.text
  });
  renderGroundList();
  setStatus(el("ntDraftStatus"), "");
}

function renderGroundList() {
  const container = el("ntGroundList");
  container.innerHTML = "";
  if (state.grounds.length === 0) {
    container.textContent = "추가된 거절이유가 없습니다.";
    container.className = "ground-list empty";
    return;
  }
  container.className = "ground-list";
  state.grounds.forEach((ground, index) => {
    const item = document.createElement("div");
    item.className = "ground-item";
    const label = document.createElement("span");
    label.innerHTML = `<strong>[거절이유 ${index + 1}]</strong> ${escapeText(ground.article)} — ${escapeText(ground.phraseTitle)}`;
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn mini-btn danger";
    delBtn.textContent = "제거";
    delBtn.addEventListener("click", () => {
      state.grounds.splice(index, 1);
      renderGroundList();
    });
    item.appendChild(label);
    item.appendChild(delBtn);
    container.appendChild(item);
  });
}

// ---------- 출원건 ----------

export async function refreshNoticeCases() {
  const select = el("ntCaseSelect");
  const cases = await listCases();
  const saved = await chrome.storage.local.get(STORAGE_KEYS.ACTIVE_CASE_ID);
  const active = state.caseId || saved[STORAGE_KEYS.ACTIVE_CASE_ID] || "";
  select.innerHTML = "";
  cases.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.title ? `${item.id} (${item.title})` : item.id;
    select.appendChild(option);
  });
  if (cases.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "— 홈에서 출원건을 먼저 생성하세요 —";
    select.appendChild(option);
  }
  state.caseId = cases.some((c) => c.id === active) ? active : (cases[0]?.id || "");
  select.value = state.caseId;
  await loadCaseContext();
}

async function loadCaseContext() {
  state.caseRecord = null;
  state.markVersion = null;
  if (!state.caseId) {
    setStatus(el("ntCaseState"), "출원건이 없습니다.");
    return;
  }
  state.caseRecord = await get("cases", state.caseId);
  if (state.caseRecord?.approvedMarkVersionId) {
    state.markVersion = await get("markVersions", state.caseRecord.approvedMarkVersionId);
    setStatus(el("ntCaseState"), `승인 1 확정본(v${state.markVersion?.seq}) 기준으로 초안을 만듭니다.`, "ok");
  } else {
    setStatus(el("ntCaseState"), "승인 1이 확정되지 않았습니다. 모듈 1에서 분석을 확정한 뒤 초안을 생성할 수 있습니다.", "warn");
  }
  await renderVersionList();
}

// ---------- 초안 조립 (코드 담당, LLM 미사용) ----------

function formatGoods(goods) {
  // 류별로 묶어서 "제25류: 티셔츠, 운동화" 형태로
  const byClass = new Map();
  (goods || []).forEach((item) => {
    const key = item.class === "unknown" ? "류 미상" : `제${item.class}류`;
    if (!byClass.has(key)) byClass.set(key, []);
    byClass.get(key).push(item.name);
  });
  return [...byClass.entries()].map(([klass, names]) => `${klass}: ${names.join(", ")}`).join("\n");
}

function buildDraft() {
  const kind = el("ntKindSelect").value;
  const mark = state.markVersion.data;
  const markText = (mark.textElements || []).map((item) => item.text).join(" ")
    || mark.figureDescription || "(표장 기재)";
  const lines = [];

  if (kind === "opinion") {
    lines.push("의 견 제 출 통 지 서");
    lines.push("");
    lines.push(`출원번호: ${state.caseId}`);
    lines.push(`표장: ${markText}`);
    lines.push("지정상품:");
    lines.push(formatGoods(mark.goods));
    lines.push("");
    lines.push("이 출원은 다음의 거절이유에 해당하므로 상표법 제55조 제1항에 따라 통지하니, 의견이 있는 경우 정해진 기간 내에 의견서를 제출하시기 바랍니다.");
  } else {
    lines.push("거 절 결 정 서");
    lines.push("");
    lines.push(`출원번호: ${state.caseId}`);
    lines.push(`표장: ${markText}`);
    lines.push("지정상품:");
    lines.push(formatGoods(mark.goods));
    lines.push("");
    lines.push("이 출원은 의견제출통지서에서 통지한 다음의 거절이유가 해소되지 아니하였으므로 상표법 제54조에 따라 거절결정합니다.");
  }

  lines.push("");
  lines.push("- 아    래 -");
  lines.push("");
  state.grounds.forEach((ground, index) => {
    lines.push(`[거절이유 ${index + 1}] ${ground.article}`);
    lines.push(ground.phraseText);
    lines.push("");
  });
  lines.push("");
  lines.push("※ 이 문서는 TRADEMARK 도구가 생성한 심사관 검토용 초안입니다.");
  return lines.join("\n");
}

function generateDraft() {
  if (!state.markVersion) {
    setStatus(el("ntDraftStatus"), "승인 1이 확정된 출원건에서만 초안을 생성할 수 있습니다.", "error");
    return;
  }
  if (state.grounds.length === 0) {
    setStatus(el("ntDraftStatus"), "거절이유를 하나 이상 추가해 주세요.", "error");
    return;
  }
  el("ntDraftText").value = buildDraft();
  el("ntDraftText").classList.remove("hidden");
  el("ntSaveBtn").disabled = false;
  el("ntHwpxBtn").disabled = false;
  state.draftReady = true;
  setStatus(el("ntDraftStatus"), "초안을 생성했습니다. 내용을 검토·수정한 뒤 저장하거나 HWPX로 내려받으세요.", "ok");
}

// ---------- 저장·HWPX ----------

async function saveDraftVersion() {
  if (!state.draftReady) return;
  const version = await addVersion("notices", state.caseId, {
    kind: el("ntKindSelect").value,
    body: el("ntDraftText").value,
    grounds: state.grounds.map(({ article, phraseId, phraseTitle }) => ({ article, phraseId, phraseTitle })),
    markVersionId: state.markVersion.id // 어느 분석 버전에서 나온 초안인지 기록 [버전 체인]
  });
  setStatus(el("ntDraftStatus"), `v${version.seq} 으로 저장했습니다.`, "ok");
  await renderVersionList();
}

async function downloadDraftHwpx() {
  if (!state.draftReady) return;
  try {
    setStatus(el("ntDraftStatus"), "HWPX 생성 중...");
    const kindName = el("ntKindSelect").value === "opinion" ? "의견제출통지서" : "거절결정서";
    await downloadHwpx(el("ntDraftText").value, `${kindName}_${state.caseId}`);
    setStatus(el("ntDraftStatus"), "HWPX 파일을 내려받았습니다. 한글(한컴오피스)에서 열어 확인해 주세요.", "ok");
  } catch (error) {
    setStatus(el("ntDraftStatus"), `HWPX 생성 실패: ${error.message}`, "error");
  }
}

async function renderVersionList() {
  const container = el("ntVersionList");
  container.innerHTML = "";
  if (!state.caseId) return;
  const versions = (await getAllByCase("notices", state.caseId)).sort((a, b) => b.seq - a.seq);
  versions.forEach((version) => {
    const item = document.createElement("div");
    item.className = "version-item";
    const tag = document.createElement("span");
    tag.className = "ver-tag";
    tag.textContent = `v${version.seq}`;
    const kind = document.createElement("span");
    kind.textContent = version.data?.kind === "rejection" ? "거절결정서" : "의견제출통지서";
    const date = document.createElement("span");
    date.className = "ver-date";
    date.textContent = (version.createdAt || "").replace("T", " ").slice(0, 16);
    const loadBtn = document.createElement("button");
    loadBtn.type = "button";
    loadBtn.className = "btn";
    loadBtn.textContent = "불러오기";
    loadBtn.addEventListener("click", () => {
      el("ntKindSelect").value = version.data?.kind || "opinion";
      el("ntDraftText").value = version.data?.body || "";
      el("ntDraftText").classList.remove("hidden");
      el("ntSaveBtn").disabled = false;
      el("ntHwpxBtn").disabled = false;
      state.draftReady = true;
      setStatus(el("ntDraftStatus"), `v${version.seq} 을(를) 불러왔습니다. 수정 후 저장하면 새 버전이 됩니다.`, "ok");
    });
    item.appendChild(tag);
    item.appendChild(kind);
    item.appendChild(date);
    item.appendChild(loadBtn);
    container.appendChild(item);
  });
}

// ---------- 초기화 ----------

export async function initNotice() {
  renderArticleSelects();
  await seedPhrasesIfNeeded();
  await renderAssetList();
  await renderPhraseSelect();
  renderGroundList();
  await refreshNoticeCases();

  el("ntCaseSelect").addEventListener("change", async () => {
    state.caseId = el("ntCaseSelect").value;
    await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_CASE_ID]: state.caseId });
    await loadCaseContext();
  });
  el("ntArticleSelect").addEventListener("change", () => void renderPhraseSelect());
  el("ntAddGroundBtn").addEventListener("click", () => void addGround());
  el("ntGenerateBtn").addEventListener("click", generateDraft);
  el("ntSaveBtn").addEventListener("click", () => void saveDraftVersion());
  el("ntHwpxBtn").addEventListener("click", () => void downloadDraftHwpx());
  el("ntAssetAddBtn").addEventListener("click", () => void addAsset());
}
