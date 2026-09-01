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

## 아직 참고할 가치가 있는 부분 (미이식)

- k-query/src/core/query_builder.js·query_validator.js — 모듈 2(검색식 조립·검증) 구현 시 구조 참고
- k-research 의 반복 루프 프롬프트(query_refine, corpus_decision) — 모듈 3 자동 루프 구현 시 참고
- k-larc 의 review-hub·verification 프롬프트 — 모듈 4 리뷰 화면 참고
- suite/query-language.js — 검색식 문법 처리 참고

필요해지면 사용자에게 KSUITE2.0.0.zip 재업로드를 요청해 해당 파일을 직접 읽을 것.
