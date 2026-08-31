# TRADEMARK — 상표 심사지원 크롬 확장프로그램

특허심사용 내부 도구 K-SUITE의 구조를 상표심사에 맞게 옮긴 Chrome 확장(Manifest V3)입니다.
별도 서버 없이 동작하며, 출원 데이터는 브라우저(IndexedDB) 밖으로 나가지 않습니다 (LLM 호출 제외).

> **이 도구는 심사를 대신하지 않습니다.** 점수와 판정은 검토 우선순위용 후보일 뿐이며, 결론은 심사관이 내립니다.

## 설치 (빌드 불필요)

K-SUITE와 같은 방식으로, 빌드 없이 폴더를 그대로 로드합니다.

1. Chrome(또는 Edge)에서 `chrome://extensions` 접속
2. 우측 상단 **개발자 모드** 켜기
3. **압축해제된 확장 프로그램을 로드합니다** 클릭 → 이 `trademark` 폴더 선택
4. 툴바의 TRADEMARK 아이콘 클릭 → 공통 설정에서 API 주소·키·모델 저장

## LLM 설정

| 환경 | Base URL | API 방식 |
|---|---|---|
| 내부망 (OpenWebUI) | 내부망 LLM 주소 | `OpenWebUI` (`/api/chat/completions`, `/api/models`) |
| 외부망 개발 (Ollama) | `http://localhost:11434/v1` | `OpenAI 호환` (`/chat/completions`, `/models`) |

- 기본 모델: `gemma4-26b-moe` (내부망) / `gemma4:26b` 또는 `gemma4:12b` (Ollama)
- **목 모드**를 켜면 LLM 없이 저장된 샘플 응답으로 화면 흐름을 확인할 수 있습니다.

## 폴더 구조

```
trademark/
├─ manifest.json          MV3 매니페스트
├─ background.js          서비스 워커 (사이드패널 열기)
├─ popup/                 모듈 런처 + 공통 설정
├─ dashboard/             통합 대시보드 (모듈 1·2·4·5 전체 탭 화면)
├─ sidepanel/             검색 에이전트 (모듈 3, 검색시스템 탭 전용)
├─ shared/
│  ├─ constants.js        공통 상수·모듈 정의·공통 금지사항
│  ├─ settings.js         공통 설정 + 단계별 덮어쓰기 + 교정지시 저장
│  ├─ llm.js              LLM 공통 래퍼 (JSON 스키마 강제, 1회 재시도, 목 모드, 청크 분할)
│  ├─ schema-validator.js 최소 JSON 스키마 검증기
│  └─ db.js               IndexedDB (출원건·버전 체인·문구 자산·목 응답)
├─ config/
│  ├─ selectors.json      검색결과 DOM 셀렉터 (내부망 반입 시 이 파일만 교체)
│  └─ query_syntax.json   검색식 연산자 문법 (내부망 반입 시 이 파일만 교체)
└─ data/
   └─ similar_group_codes.json  지정상품 → 유사군코드 기준표 (코드 매칭용, LLM 미사용)
```

## 개발 현황

| 단계 | 내용 | 상태 |
|---|---|---|
| 1 | 뼈대: manifest, 팝업(런처+설정), llm.js, IndexedDB | ✅ 완료 — 테스트 대기 |
| 2 | 모듈 1: 출원상표 분석 + 승인 1 | ⬜ |
| 3 | 모듈 5 최소판: 문구 템플릿 + 통지서 초안 + HWPX (→ MVP) | ⬜ |
| 4 | 모듈 2: 칭호 변형 엔진 + 검색식 조립 + 승인 2 | ⬜ |
| 5 | 모듈 3: 사이드패널 검색 에이전트 | ⬜ |
| 6 | 모듈 4: 유사판단 리뷰 + 문구 자산 | ⬜ |
| 7 | 모듈 5 완성: 근거 제한·대화형 수정·재검토 표시 | ⬜ |
| 8 | 내부망 반입: 셀렉터·문법 파일 교체, 이미지 입력 반영 | ⬜ |

## 1단계 테스트 방법

1. 확장 프로그램 로드 후 팝업 열기 → 공통 설정이 자동으로 열림
2. Base URL·API 방식·API Key 입력 → **모델 목록** 버튼 → 모델 목록이 뜨는지 확인
   - 외부망: Ollama 실행 후 `http://localhost:11434/v1` + `OpenAI 호환` 선택
3. **저장** → 팝업에서 **통합 대시보드** 카드 클릭
4. 대시보드 홈에서 **연결 테스트** → "연결됨" 배지 확인
5. 출원건 생성/삭제 → 목록에 나타나고, 새로고침 후에도 유지되는지 확인 (IndexedDB)
