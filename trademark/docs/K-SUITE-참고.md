# K-SUITE 참고 정리 (KSUITE2.0.0.zip 분석 요약)

TRADEMARK 는 특허심사용 내부 도구 K-SUITE 의 구조를 상표심사에 옮긴 것이다.
원본 zip 은 사용자가 보유(저장소에 없음). 이 문서는 새 세션이 원본 없이도 맥락을 잇도록 핵심을 남긴 것.

## 전체 구조 (187파일, 7.2MB, 빌드 없음)

```
suite/                  공통 계층: popup(런처+설정), dashboard, module-registry,
                        shared-constants, case-store, llm-request-policy, runtime-router
modules/k-larc/         발명 분석·리뷰 허브 (prompts/ 폴더: system.txt/user.txt/schema.json 단위)
modules/k-query/        검색식 생성 — 3레이어 (layer_1 추출/관계/우선순위, layer_2 확장, layer_3 조립·검증)
modules/k-research/     검색 에이전트 (query_seed/refine/remap, citation_eval, corpus_decision 프롬프트)
modules/k-scan/         화면 캡처 분석
modules/k-notice/       통지서 + HWPX 출력 (hwpx.js, assets/base.hwpx)
```

## 확정 사실 (코드에서 실측)

- **빌드 없이 순수 JS**를 "압축해제된 확장 프로그램 로드"로 설치 — TRADEMARK 도 동일 방식 채택
- **내부망 LLM**: `DEFAULT_WEBUI_BASE_URL = "https://llm.moip.go.kr"` (suite/shared-constants.js, k-query/api_clients.js 에 하드코딩), 기본 모델 `gemma-26b-moe`, 엔드포인트 `POST {base}/api/chat/completions` (OpenWebUI)
- **승인 캡처 호스트**: `APPROVED_CAPTURE_HOST = "kpowps.kipo.go.kr"` — K-SCAN/K-Research 는 이 탭(KOMPASS)에서만 사이드패널 열림. 즉 **kpowps 는 내부망 크롬에서 열리는 시스템** (상표 자동 가져오기 후보)
- **설정 공유**: chrome.storage.local, 공유 API 키 1개 (구버전 키 자동 마이그레이션 코드 존재 → 여러 차례 중앙 배포된 운영 제품)
- **사이드패널 열기**: 팝업에서 직접 시도 → 실패 시 서비스워커 중계 (TRADEMARK 도 동일 패턴)
- **프롬프트 관리**: 단계별 폴더(system/user/schema 분리). TRADEMARK 는 JS 모듈 내 상수로 단순화

## TRADEMARK 로 이식한 것

| K-SUITE 원본 | TRADEMARK | 변경점 |
|---|---|---|
| modules/k-notice/scripts/hwpx.js | shared/hwpx.js | IIFE → ES 모듈, fetch 경로 chrome.runtime.getURL, 제목 K-NOTICE→TRADEMARK. 자체 ZIP 읽기/쓰기(CRC32·deflate-raw)로 외부 라이브러리 불필요. base.hwpx 의 {{K_NOTICE_BODY}} 표식 문단을 본문으로 치환 |
| modules/k-notice/assets/base.hwpx | assets/base.hwpx | 그대로 복사 (사용자 HWPX 샘플 받으면 교체 예정) |
| suite 팝업 구조 (설정 시트·모듈 카드·모델 목록 조회) | popup/ | 재작성 |
| K-QUERY 3레이어 개념 | (4단계 모듈 2에서 구현 예정) | 지시서가 "K-QUERY 3-레이어 구조 그대로" 요구 |
| 승인 게이트·케이스 흐름 개념 | 승인 1·승인 2 게이트 | 지시서 설계 원칙 |

## 자동 검색 연동 방식 (2026-09-01 zip 재분석 — k-research 실측)

**결론: K-SUITE 는 내부망과 "연동 API"가 전혀 없다. 크롬에서 열리는 KOMPASS 웹페이지를 확장이 원격 조종하는 것이 전부다.**

- manifest: `host_permissions` 는 딱 2개 — `https://kpowps.kipo.go.kr/*` (KOMPASS), `https://llm.moip.go.kr/*` (LLM). content_scripts 없음. 권한: storage·tabs·scripting·activeTab·**debugger**·sidePanel·clipboardWrite·offscreen. 최소 크롬 114
- **검색식 입력·실행 = DOM 조종** (`chrome.scripting.executeScript({world:"MAIN"})` 로 KOMPASS 탭에 함수 주입):
  - `injectKompassQueryText`: `textarea[id*="freeword_textarea"]` 를 찾아 네이티브 setter 로 값 설정 + input/change 이벤트 발화
  - `injectKompassSearchClick`: 검색 버튼에 mouseover→mousedown→mouseup→click 순서로 이벤트 발화. 결과건수 표기("N건/총…")를 텍스트 워커로 찾아 화면 변화를 감시
  - confirm/alert 다이얼로그는 모든 프레임에 감시자를 주입해 자동 처리 (자동 모드에선 confirm 을 cancel)
- **검색결과 수집 = CDP 네트워크 가로채기** (DOM 파싱이 아님): `chrome.debugger.attach(tab, "1.3")` + `Network.enable` 후 `Network.responseReceived/loadingFinished` 를 듣고, `/bpService.do` (서비스 ID SKGM10500/SKGM010500 계열)·`/getDWPIAbst.do` 응답 본문을 `Network.getResponseBody` 로 읽는다. 즉 KOMPASS 웹앱이 자기 서버에서 받는 JSON 을 그대로 채간다 → 정확한 구조화 데이터. 이 방식은 크롬 상단에 "디버깅 중" 노란 띠가 뜬다
- **자동 반복 루프**는 사이드패널의 18단계 상태기계: prepare → ensure_initial_query(LLM query_seed) → validate_query → start_capture(디버거 부착) → click_initial_screen → apply_query → click_search → wait_dialog → wait_result_count → 건수 조절(handle_count_many: LLM query_refine 으로 narrow/widen, 최대 연속 30회 조정·총 31회 시도) → claim batch(상세 탭 열어 캡처 후 닫기) → finish_cycle(citation_eval 평가) → advance_iteration → completed
- 안전장치: 자동 세션 lease(패널 1개만 자동 실행, 90초 TTL 하트비트), 검색시도 예약(같은 검색식 이중 실행 방지, 실행 여부 불명이면 일시정지), 수동 개입 시 자동 차단
- **따라서 상표에서 자동 검색이 가능한지는 오직 "상표 검색 화면이 크롬에서 열리는가"에 달렸다.** IE 전용 화면은 K-SUITE 도 절대 조종 못 한다. kpowps 가 크롬에서 열린다는 건 K-SUITE 운영으로 증명된 사실 — 상표 검색이 KOMPASS(또는 크롬 호환 다른 호스트)에서 되는지 확인이 선결 과제

## 아직 참고할 가치가 있는 부분 (미이식)

- k-query/src/core/query_builder.js·query_validator.js — 모듈 2(검색식 조립·검증) 구현 시 구조 참고
- k-research 의 반복 루프 프롬프트(query_refine, corpus_decision) — 모듈 3 자동 루프 구현 시 참고
- k-larc 의 review-hub·verification 프롬프트 — 모듈 4 리뷰 화면 참고
- suite/query-language.js — 검색식 문법 처리 참고

필요해지면 사용자에게 KSUITE2.0.0.zip 재업로드를 요청해 해당 파일을 직접 읽을 것.
