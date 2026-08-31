// IndexedDB 저장 계층 [지시서 4. 데이터 모델]
//
// 출원건별 데이터·버전 이력·템플릿·문구 자산을 브라우저 안에만 저장한다.
// 브라우저 밖으로 나가는 데이터 없음 (LLM 호출 제외).
//
// 오브젝트 스토어:
//   cases          출원건 { id: caseId(출원번호), createdAt, updatedAt, title, approvedMarkVersionId, approvedSearchBriefId, ... }
//   markVersions   출원상표 분석 버전 { id: markVersionId, caseId, seq, data, approvedAt } — 승인 1 시점 고정 [원칙 3·4]
//   searchBriefs   검색 준비서 버전   { id: searchBriefId, caseId, seq, data, approvedAt } — 승인 2 시점 고정
//   searchRuns     검색 실행 1회      { id: searchRunId, caseId, searchBriefId, query, resultCount, ... }
//   candidates     선행상표 후보      { id, caseId, label: P0001~, ... }
//   evidence       채택된 근거        { id, caseId, label: R0001~, kind: "priorMark" | "phrase", ... }
//   grounds        거절이유 조합      { id: groundId, caseId, article, evidenceIds, ... }
//   notices        통지서 초안 버전   { id: noticeId, caseId, seq, kind, body, ... }
//   phraseAssets   판례·심사기준 문구 자산 (전역) { id, source, caseNo, text, usage, approved }
//   templates      통지서 템플릿 (전역) { id, kind, body }
//   mockResponses  목 모드 샘플 응답 { id: promptKey, data }
//   counters       ID 채번용 { id: `${caseId}:${prefix}`, value }

const DB_NAME = "trademark-suite";
const DB_VERSION = 1;

const STORES = [
  { name: "cases", options: { keyPath: "id" }, indexes: [] },
  { name: "markVersions", options: { keyPath: "id" }, indexes: [["caseId", "caseId"]] },
  { name: "searchBriefs", options: { keyPath: "id" }, indexes: [["caseId", "caseId"]] },
  { name: "searchRuns", options: { keyPath: "id" }, indexes: [["caseId", "caseId"]] },
  { name: "candidates", options: { keyPath: "id" }, indexes: [["caseId", "caseId"]] },
  { name: "evidence", options: { keyPath: "id" }, indexes: [["caseId", "caseId"]] },
  { name: "grounds", options: { keyPath: "id" }, indexes: [["caseId", "caseId"]] },
  { name: "notices", options: { keyPath: "id" }, indexes: [["caseId", "caseId"]] },
  { name: "phraseAssets", options: { keyPath: "id" }, indexes: [] },
  { name: "templates", options: { keyPath: "id" }, indexes: [] },
  { name: "mockResponses", options: { keyPath: "id" }, indexes: [] },
  { name: "counters", options: { keyPath: "id" }, indexes: [] }
];

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      STORES.forEach((store) => {
        if (!db.objectStoreNames.contains(store.name)) {
          const os = db.createObjectStore(store.name, store.options);
          store.indexes.forEach(([indexName, keyPath]) => {
            os.createIndex(indexName, keyPath, { unique: false });
          });
        }
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB를 열 수 없습니다."));
  });
  return dbPromise;
}

// 트랜잭션 1회 실행 헬퍼
async function withStore(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    try {
      result = fn(store);
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => {
      if (result && typeof result.onsuccess !== "undefined") {
        resolve(result.result);
      } else {
        resolve(result);
      }
    };
    tx.onerror = () => reject(tx.error || new Error(`트랜잭션 실패: ${storeName}`));
    tx.onabort = () => reject(tx.error || new Error(`트랜잭션 중단: ${storeName}`));
  });
}

// ---------- 범용 CRUD ----------

export async function put(storeName, record) {
  return withStore(storeName, "readwrite", (store) => store.put(record));
}

export async function get(storeName, id) {
  const req = await withStore(storeName, "readonly", (store) => store.get(id));
  return req ?? null;
}

export async function remove(storeName, id) {
  return withStore(storeName, "readwrite", (store) => store.delete(id));
}

export async function getAll(storeName) {
  return withStore(storeName, "readonly", (store) => store.getAll());
}

export async function getAllByCase(storeName, caseId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const index = tx.objectStore(storeName).index("caseId");
    const req = index.getAll(caseId);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// ---------- ID 채번 [데이터 모델: P0001~, R0001~, 버전 번호] ----------

// 예: nextId(caseId, "P") → "P0001", nextId(caseId, "R") → "R0001"
// 읽기와 증가를 한 트랜잭션에서 처리해 중복 채번을 막는다.
export async function nextId(caseId, prefix, digits = 4) {
  const counterId = `${caseId}:${prefix}`;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("counters", "readwrite");
    const store = tx.objectStore("counters");
    let label = "";
    const req = store.get(counterId);
    req.onsuccess = () => {
      const next = (req.result?.value || 0) + 1;
      store.put({ id: counterId, value: next });
      label = `${prefix}${String(next).padStart(digits, "0")}`;
    };
    tx.oncomplete = () => resolve(label);
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- 출원건(case) ----------

export async function createCase({ caseId, title }) {
  const id = String(caseId || "").trim();
  if (!id) throw new Error("출원번호(caseId)가 필요합니다.");
  const existing = await get("cases", id);
  if (existing) throw new Error(`이미 등록된 출원건입니다: ${id}`);
  const now = new Date().toISOString();
  const record = {
    id,
    title: String(title || "").trim(),
    createdAt: now,
    updatedAt: now,
    approvedMarkVersionId: null,   // 승인 1 — 확정된 출원상표 분석 버전
    approvedSearchBriefId: null    // 승인 2 — 확정된 검색 준비서 버전
  };
  await put("cases", record);
  return record;
}

export async function listCases() {
  const all = await getAll("cases");
  return all.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export async function touchCase(caseId, patch = {}) {
  const record = await get("cases", caseId);
  if (!record) throw new Error(`출원건을 찾을 수 없습니다: ${caseId}`);
  const updated = { ...record, ...patch, updatedAt: new Date().toISOString() };
  await put("cases", updated);
  return updated;
}

// 출원건과 관련 데이터 전체 삭제 (되돌릴 수 없음 — 호출부에서 확인 후 사용)
export async function deleteCaseCascade(caseId) {
  const caseScoped = ["markVersions", "searchBriefs", "searchRuns", "candidates", "evidence", "grounds", "notices"];
  for (const storeName of caseScoped) {
    const rows = await getAllByCase(storeName, caseId);
    for (const row of rows) {
      await remove(storeName, row.id);
    }
  }
  await remove("cases", caseId);
}

// ---------- 버전 체인 [설계 원칙 4] ----------

// 산출물 버전 추가: 같은 caseId 안에서 seq 를 1씩 올리고 이전 버전은 보존한다.
export async function addVersion(storeName, caseId, data, extra = {}) {
  const rows = await getAllByCase(storeName, caseId);
  const seq = rows.reduce((max, row) => Math.max(max, row.seq || 0), 0) + 1;
  const record = {
    id: `${caseId}:${storeName}:v${seq}`,
    caseId,
    seq,
    createdAt: new Date().toISOString(),
    approvedAt: null,
    data,
    ...extra
  };
  await put(storeName, record);
  return record;
}

// ---------- 목 모드 샘플 응답 ----------

export async function getMockResponse(promptKey) {
  const row = await get("mockResponses", promptKey);
  return row ? row.data : null;
}

export async function setMockResponse(promptKey, data) {
  await put("mockResponses", { id: promptKey, data, updatedAt: new Date().toISOString() });
}
