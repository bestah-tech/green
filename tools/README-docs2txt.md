# 판례 문서 → TXT 일괄 변환 (`docs2txt.py`)

PDF + 한글(HWP/HWPX)이 섞인 판례 모음집을 TXT로 변환해, LLM 프로젝트 컨텍스트에
넣기 좋게 용량을 줄입니다. 한글 파일은 **한글 프로그램 없이** 순수 파이썬으로 직접
파싱합니다(HWP 5.0 바이너리 스펙 + HWPX의 XML).

## 설치

```bash
pip install pymupdf olefile
# 스캔본 PDF까지 OCR 하려면 (선택, 매우 느림)
pip install pytesseract pillow
sudo apt install tesseract-ocr tesseract-ocr-kor     # 또는 brew install tesseract tesseract-lang
```

## 사용법

```bash
# 기본: 폴더 통째로 변환 (하위 폴더 구조 유지)
python3 tools/docs2txt.py -i ./판례 -o ./판례_txt

# 컨텍스트용으로 한 파일에 합치고 5MB씩 자르기
python3 tools/docs2txt.py -i ./판례 -o ./판례_txt --merge --chunk-mb 5

# 빈 줄까지 제거해 용량 최소화
python3 tools/docs2txt.py -i ./판례 -o ./판례_txt --merge --compact

# 스캔본(이미지) PDF까지 OCR
python3 tools/docs2txt.py -i ./판례 -o ./판례_txt --ocr
```

| 옵션 | 설명 |
| --- | --- |
| `-i, --input` | 원본 폴더 (하위 폴더 재귀 탐색) |
| `-o, --output` | TXT 저장 폴더 |
| `-j, --workers` | 병렬 프로세스 수 (기본: CPU 수, 최대 8) |
| `--merge` | 전체를 `merged.txt` 하나로 합침 |
| `--chunk-mb N` | `--merge` 결과를 N MB 단위로 분할 |
| `--compact` | 빈 줄까지 제거 (문단 구분은 사라짐) |
| `--keep-headers` | PDF 반복 머리말/꼬리말을 지우지 않음 |
| `--ocr` | 텍스트 레이어 없는 PDF를 OCR (kor+eng) |
| `--min-chars N` | N자 미만이면 "확인 필요"로 표시 (기본 50) |

## 지원 형식

| 형식 | 처리 방식 |
| --- | --- |
| `.pdf` | PyMuPDF 텍스트 레이어 추출, 스캔본은 `--ocr` |
| `.hwp` | 한글 5.0 OLE 직접 파싱 (BodyText 섹션 → zlib → 레코드 → UTF-16) |
| `.hwpx`, `.hwt` | ZIP 안의 `Contents/section*.xml` 파싱 |
| `.docx .doc .rtf .odt` | LibreOffice(`soffice`)가 설치돼 있으면 변환 |
| `.txt .md` | CP949/EUC-KR 등 자동 판별 후 UTF-8 정규화 |

## 용량 줄이기 위해 하는 일

- 페이지마다 반복되는 **머리말·꼬리말**(법원명, 사건번호 등)을 자동 감지해 제거
  — 전체 페이지의 60% 이상에 같은 줄이 나오면 반복으로 판단
- `- 3 -`, `3 / 27`, `제 4 쪽` 같은 **페이지 번호 줄** 제거
- 제어문자·연속 공백·3줄 이상 빈 줄 정리, 유니코드 **NFC 정규화**
  (macOS에서 만든 자모 분리 텍스트가 토큰을 2~3배 먹는 것을 막음)

## 결과물

```
판례_txt/
├── 대법원_2018다27454.txt      # 원본과 같은 폴더 구조로 1:1 변환
├── ...
├── merged.txt                  # --merge 시
└── _manifest.csv               # 파일별 상태·글자수·용량 (Excel에서 바로 열림)
```

각 TXT 첫 줄에 `# 출처: 원본파일명`이 들어가서, 합쳐도 어느 판례인지 추적됩니다.

## 실패하는 경우

`_manifest.csv`의 `상태` 열과 실행 마지막의 "확인 필요" 목록을 보세요.

| 상태 | 의미 | 대처 |
| --- | --- | --- |
| `scanned` | PDF에 텍스트 레이어 없음 (스캔본) | `--ocr` 로 재실행 |
| `empty` | 추출 결과가 거의 없음 | 원본을 열어 확인, 대개 스캔본 |
| `error` | 암호/배포용(DRM)/손상/구버전(한글 3.0) | 한글에서 열어 일반 문서로 다시 저장 |

특히 **배포용 문서(DRM)** 와 **암호 걸린 파일**은 어떤 도구로도 자동 변환이 안 됩니다.
한글에서 열어 `다른 이름으로 저장`(hwp 또는 hwpx) 한 뒤 다시 돌리면 됩니다.
