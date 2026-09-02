#!/usr/bin/env python3
"""판례 모음집(PDF/HWP/HWPX 등)을 TXT로 일괄 변환하는 스크립트.

LLM 프로젝트 컨텍스트로 넣기 좋게 용량을 줄이는 데 초점을 맞춘다.
  - PDF  : PyMuPDF(fitz)로 텍스트 레이어 추출, 스캔본은 OCR(선택) 또는 리포트
  - HWP  : 한글 5.0 바이너리(OLE) 포맷을 직접 파싱 (외부 프로그램 불필요)
  - HWPX : ZIP + XML 파싱
  - DOCX/DOC/RTF/ODT : LibreOffice(soffice)가 있으면 변환
  - TXT  : 인코딩만 UTF-8로 정규화

사용 예:
    python3 tools/docs2txt.py -i ./판례 -o ./판례_txt
    python3 tools/docs2txt.py -i ./판례 -o ./out --merge --chunk-mb 5
    python3 tools/docs2txt.py -i ./판례 -o ./out --ocr        # 스캔 PDF까지

필요 패키지:
    pip install pymupdf olefile          # 기본
    pip install pytesseract pillow       # --ocr 사용 시 (+ tesseract-ocr-kor)
"""

from __future__ import annotations

import argparse
import csv
import os
import re
import struct
import sys
import unicodedata
import zipfile
import zlib
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from xml.etree import ElementTree as ET

SUPPORTED_EXT = {
    ".pdf", ".hwp", ".hwpx", ".hwt",
    ".docx", ".doc", ".rtf", ".odt",
    ".txt", ".md",
}

# LibreOffice로 우회 변환할 확장자
SOFFICE_EXT = {".docx", ".doc", ".rtf", ".odt"}


# ──────────────────────────────────────────────────────────────────────────
# 결과 자료구조
# ──────────────────────────────────────────────────────────────────────────
@dataclass
class Result:
    src: str
    dst: str = ""
    kind: str = ""
    status: str = "ok"          # ok | empty | scanned | error | skipped
    detail: str = ""
    src_bytes: int = 0
    out_bytes: int = 0
    chars: int = 0
    pages: int = 0
    warnings: list[str] = field(default_factory=list)
    masked: dict[str, int] = field(default_factory=dict)


# ──────────────────────────────────────────────────────────────────────────
# 공통 텍스트 정리
# ──────────────────────────────────────────────────────────────────────────
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_SOFT = re.compile(r"[­​-‏⁠﻿]")   # soft hyphen, ZWSP, BOM 등
_MULTISPACE = re.compile(r"[ \t 　]{2,}")
_BLANKS = re.compile(r"\n{3,}")
# "- 3 -", "3 / 27", "제 1 쪽", "페이지 4" 같이 페이지 번호만 있는 줄
_PAGENO = re.compile(
    r"^\s*(?:[-–—~<\[(]*\s*)?(?:page|Page|PAGE|페이지|쪽|제)?\s*"
    r"\d{1,4}\s*(?:/\s*\d{1,4})?\s*(?:쪽|페이지|면)?\s*(?:[-–—~>\])]*)\s*$"
)


def clean_text(text: str) -> str:
    """제어문자/중복공백 제거 + 유니코드 정규화. 한글은 NFC로 통일한다."""
    # 짝이 깨진 서로게이트가 남아 있으면 UTF-8로 저장할 수 없으므로 먼저 걸러낸다
    if any("\ud800" <= ch <= "\udfff" for ch in text):
        text = text.encode("utf-8", "replace").decode("utf-8")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _SOFT.sub("", text)
    text = _CTRL.sub("", text)
    # 자모 분리(NFD) 상태로 저장된 파일명/본문을 NFC로 합쳐 토큰 수를 줄인다
    text = unicodedata.normalize("NFC", text)

    lines = []
    for line in text.split("\n"):
        line = _MULTISPACE.sub(" ", line).strip()
        lines.append(line)
    text = "\n".join(lines)
    text = _BLANKS.sub("\n\n", text)
    return text.strip()


def drop_page_numbers(lines: list[str]) -> list[str]:
    return [ln for ln in lines if not _PAGENO.match(ln)]


def strip_repeated_headers(pages: list[str], threshold: float = 0.6) -> list[str]:
    """여러 페이지에 반복되는 머리말/꼬리말을 제거한다.

    페이지 상·하단 2줄을 후보로 보고, 전체 페이지의 threshold 이상에서
    동일하게 나타나면 제거한다. (법원명·사건번호 반복 등으로 용량이 꽤 준다)
    """
    if len(pages) < 4:
        return pages

    from collections import Counter

    counter: Counter[str] = Counter()
    for page in pages:
        lines = [ln.strip() for ln in page.split("\n") if ln.strip()]
        for cand in lines[:2] + lines[-2:]:
            if 2 <= len(cand) <= 80:
                counter[cand] += 1

    limit = max(3, int(len(pages) * threshold))
    repeated = {line for line, n in counter.items() if n >= limit}
    if not repeated:
        return pages

    out = []
    for page in pages:
        lines = page.split("\n")
        head = 0
        while head < len(lines) and (not lines[head].strip() or lines[head].strip() in repeated):
            head += 1
        tail = len(lines)
        while tail > head and (not lines[tail - 1].strip() or lines[tail - 1].strip() in repeated):
            tail -= 1
        out.append("\n".join(lines[head:tail]))
    return out


# ──────────────────────────────────────────────────────────────────────────
# 개인정보 마스킹 (--mask)
#
# 판결문·심결문의 당사자 실명·주소를 가린다. 같은 사람은 문서 안에서 같은
# 번호를 받으므로("[성명1]") 누가 누구인지 관계는 유지된 채 신원만 가려진다.
# 이름 사전이 아니라 문서 구조(당사자 표시줄, 직함, 주소 형태)로 판단한다.
# 상표·서비스표 이름과 법원명·사건번호는 판례의 핵심이라 건드리지 않는다.
# 법인명도 기본적으로 남긴다 (--mask-corp 로 함께 가릴 수 있음).
# ──────────────────────────────────────────────────────────────────────────
# ── 법인·단체를 나타내는 낱말. 이게 들어 있으면 개인 이름으로 보지 않는다 ──
CORP_WORDS = (
    "주식회사", "유한회사", "유한책임회사", "합자회사", "합명회사", "(주)", "㈜",
    "법무법인", "특허법인", "법률사무소", "특허사무소", "변리사사무소", "회계법인",
    "재단법인", "사단법인", "학교법인", "의료법인", "영농조합", "협동조합", "조합",
    "공사", "공단", "진흥원", "연구원", "연구소", "협회", "학회", "센터", "재단",
    "대학교", "대학", "병원", "은행", "그룹", "홀딩스", "코퍼레이션", "컴퍼니",
    "Inc", "Ltd", "LLC", "Corp", "Co.", "GmbH", "S.A", "B.V", "N.V", "AG", "KG",
)

# ── 당사자 표시줄 라벨. 판결문은 "원 고", 심결문은 "청구인" 등으로 쓴다 ──
PARTY_LABELS = (
    "원고", "피고", "원고겸피고", "피고겸원고", "항소인", "피항소인",
    "상고인", "피상고인", "청구인", "피청구인", "신청인", "피신청인",
    "채권자", "채무자", "참가인", "보조참가인", "선정당사자", "당사자",
    "출원인", "권리자", "심판청구인", "피심판청구인", "이의신청인",
)
# 라벨 안에 공백이 들어간 표기("원  고")까지 잡는다
_LABEL_ALT = "|".join(r"\s*".join(lb) for lb in sorted(PARTY_LABELS, key=len, reverse=True))
_PARTY_LINE = re.compile(
    rf"^(?P<label>(?:{_LABEL_ALT}))"
    r"(?P<paren>\s*\([^)]{0,20}\))?"       # "원고(반소피고)"
    r"(?P<sep>[\s:\t]+)"
    r"(?P<value>\S.*)$"
)

# ── 직함 뒤에 오는 사람 이름 ──
ROLE_WORDS = (
    "소송대리인", "담당변호사", "담당변리사", "변호사", "변리사", "법무담당관",
    "대표이사", "대표자", "대표", "사내이사", "감사", "지배인",
    "법정대리인", "특별대리인", "성년후견인", "파산관재인",
    "재판장", "주심", "판사", "대법관", "심판장", "심판관", "심사관",
)
_ROLE = re.compile(
    rf"(?P<role>{'|'.join(sorted(ROLE_WORDS, key=len, reverse=True))})"
    r"(?P<sep>\s*)"
    # 값 자리에 또 다른 직함이나 법인 표시가 오면 매치하지 않는다.
    # 그래야 "재판장 판사 홍길동"에서 '판사 홍길동'이 다시 검사된다.
    rf"(?!(?:{'|'.join(sorted(ROLE_WORDS, key=len, reverse=True))})\b)"
    r"(?!(?:주식회사|유한회사|법무법인|특허법인|법률사무소|특허사무소|회계법인"
    r"|재단법인|사단법인|학교법인|의료법인))"
    r"(?P<value>[가-힣]{2,5}(?:\s*[,·]\s*[가-힣]{2,5})*)"
)

# ── 한국인 성(姓). 이름 판별의 1차 관문 ──
_SURNAME_2 = ("남궁", "황보", "제갈", "사공", "선우", "서문", "독고", "동방", "망절")
_SURNAME_1 = set(
    "김이박최정강조윤장임한오서신권황안송류유홍전고문손양배백허남심노하곽성차주우구민진지엄"
    "채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국어은편용예봉학"
)

# ── 주소 ──
_ADDR_START = re.compile(
    r"(?:[가-힣]{2,8}(?:특별시|광역시|특별자치시|특별자치도)"
    r"|(?:경기|강원|충청북|충청남|전라북|전라남|경상북|경상남|제주)도"
    r"|(?:충북|충남|전북|전남|경북|경남)\b"
    r"|[가-힣]{2,6}시(?![장민청])"          # 부천시 (시장·시민·시청은 제외)
    r"|[가-힣]{2,6}군(?![인사])"
    r"|[가-힣]{2,6}구(?![청역])"
    r")"
)
_ADDR_HINT = re.compile(
    r"(?:[가-힣A-Za-z0-9]+\s*(?:로|길)\s*\d+"       # 조마루로 212
    r"|\d+\s*번지"
    r"|\d+\s*동\s*\d+\s*호"                         # 1203동 1001호
    r"|\d+\s*호\s*(?:\(|$)"
    r"|아파트|빌딩|빌라|타워|오피스텔|상가)"
)

_RRN = re.compile(r"\b\d{6}\s*[-–]\s*\d{7}\b")
_BIZNO = re.compile(r"\b\d{3}\s*-\s*\d{2}\s*-\s*\d{5}\b")
_PHONE = re.compile(r"\b0\d{1,2}\s*[-)]\s*\d{3,4}\s*-\s*\d{4}\b")
_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
_ACCOUNT = re.compile(r"\b\d{2,6}-\d{2,6}-\d{4,8}\b")


# 성(姓)으로 시작하지만 사람 이름이 아닌 낱말들
NOT_NAMES = set(ROLE_WORDS) | {
    "원고", "피고", "본인", "상대방", "제3자", "성명", "주소", "주문", "이유",
    "별지", "위와", "동일", "유사", "기각", "인용", "각하", "취소", "무효",
    "상표", "표장", "상품", "서비스", "구성", "명칭", "도형", "문자",
}


def is_corp(value: str) -> bool:
    return any(w in value for w in CORP_WORDS)


def looks_like_person(value: str) -> bool:
    """한국인 성명 형태인지. 성(姓)으로 시작하는 2~4자 한글 한 낱말만 인정한다."""
    value = value.strip()
    if is_corp(value):
        return False
    # "홍길동 (홍길동)" 처럼 괄호가 붙은 경우 앞부분만 본다
    value = re.sub(r"\s*\(.*\)\s*$", "", value).strip()
    if value in NOT_NAMES:
        return False
    if not re.fullmatch(r"[가-힣]{2,4}", value):
        return False
    return value[:2] in _SURNAME_2 or value[0] in _SURNAME_1


class Masker:
    """문서 하나를 처리하는 동안 같은 값에 같은 가명을 붙여준다."""

    def __init__(self, mask_corp: bool = False):
        self.mask_corp = mask_corp
        self._names: dict[str, str] = {}
        self._addrs: dict[str, str] = {}
        self.counts: dict[str, int] = {}

    def _bump(self, kind: str) -> None:
        self.counts[kind] = self.counts.get(kind, 0) + 1

    def name_token(self, value: str) -> str:
        key = value.strip()
        if key not in self._names:
            self._names[key] = f"[성명{len(self._names) + 1}]"
        self._bump("성명")
        return self._names[key]

    def addr_token(self, value: str) -> str:
        key = re.sub(r"\s+", " ", value.strip())
        if key not in self._addrs:
            self._addrs[key] = f"[주소{len(self._addrs) + 1}]"
        self._bump("주소")
        return self._addrs[key]

    # ── 줄 단위 처리 ────────────────────────────────────────────────
    def _mask_party_line(self, line: str) -> str:
        m = _PARTY_LINE.match(line)
        if not m:
            return line
        value = m.group("value").strip()
        if is_corp(value) and not self.mask_corp:
            return line
        if is_corp(value):
            head = f"{m.group('label')}{m.group('paren') or ''}{m.group('sep')}"
            self._bump("법인")
            return head + "[법인]"
        if not looks_like_person(value):
            return line
        head = f"{m.group('label')}{m.group('paren') or ''}{m.group('sep')}"
        return head + self.name_token(value)

    def _mask_roles(self, line: str) -> str:
        def repl(m: re.Match) -> str:
            names = re.split(r"\s*[,·]\s*", m.group("value"))
            out = []
            for nm in names:
                out.append(self.name_token(nm) if looks_like_person(nm) else nm)
            if all(o == n for o, n in zip(out, names)):
                return m.group(0)        # 바뀐 게 없으면 원문 유지
            return f"{m.group('role')}{m.group('sep')}" + ", ".join(out)

        return _ROLE.sub(repl, line)

    def _mask_address(self, line: str) -> str:
        m = _ADDR_START.search(line)
        if not m or not _ADDR_HINT.search(line[m.start():]):
            return line
        return line[:m.start()] + self.addr_token(line[m.start():])

    def _mask_ids(self, line: str) -> str:
        for pat, label, kind in (
            (_RRN, "[주민번호]", "주민번호"),
            (_BIZNO, "[사업자번호]", "사업자번호"),
            (_PHONE, "[전화번호]", "전화번호"),
            (_EMAIL, "[이메일]", "이메일"),
            (_ACCOUNT, "[계좌번호]", "계좌번호"),
        ):
            line, n = pat.subn(label, line)
            if n:
                self.counts[kind] = self.counts.get(kind, 0) + n
        return line

    def run(self, text: str) -> str:
        out = []
        for line in text.split("\n"):
            line = self._mask_ids(line)
            masked = self._mask_party_line(line)
            if masked != line:
                out.append(masked)
                continue
            line = self._mask_address(line)
            line = self._mask_roles(line)
            out.append(line)
        return "\n".join(out)


def mask_pii(text: str, mask_corp: bool = False) -> tuple[str, dict[str, int]]:
    """마스킹된 텍스트와 항목별 처리 건수를 돌려준다."""
    m = Masker(mask_corp=mask_corp)
    return m.run(text), m.counts


# ──────────────────────────────────────────────────────────────────────────
# PDF
# ──────────────────────────────────────────────────────────────────────────
def _pymupdf():
    """`import fitz`는 매번 deprecation 경고를 찍으므로 새 이름을 먼저 시도한다."""
    try:
        import pymupdf
        return pymupdf
    except ImportError:
        import fitz
        return fitz


def extract_pdf(path: Path, res: Result, ocr: bool = False, keep_headers: bool = False) -> str:
    fitz = _pymupdf()

    doc = fitz.open(path)
    if doc.needs_pass:
        doc.close()
        raise RuntimeError("암호가 걸린 PDF (비밀번호 필요)")

    res.pages = doc.page_count
    pages: list[str] = []
    empty_pages = 0

    for page in doc:
        # "text" 모드는 읽기 순서를 비교적 잘 지키고 결과가 가장 가볍다
        txt = page.get_text("text", sort=True) or ""
        if not txt.strip():
            empty_pages += 1
        pages.append(txt)

    # 텍스트 레이어가 거의 없으면 스캔본 → 필요 시 OCR
    scanned = doc.page_count > 0 and empty_pages / doc.page_count > 0.7
    if scanned and ocr:
        pages = _ocr_pdf(doc, res)
    elif scanned:
        res.status = "scanned"
        res.detail = f"텍스트 레이어 없음(빈 페이지 {empty_pages}/{doc.page_count}) — --ocr 필요"

    doc.close()

    # 페이지 번호를 먼저 지워야 그 위의 꼬리말이 마지막 줄로 노출되어 함께 제거된다
    pages = ["\n".join(drop_page_numbers(clean_text(p).split("\n"))) for p in pages]
    if not keep_headers:
        pages = strip_repeated_headers(pages)
    return clean_text("\n".join(pages))


def _ocr_pdf(doc, res: Result) -> list[str]:
    """스캔 PDF를 300dpi 렌더링 후 tesseract(kor+eng)로 OCR."""
    try:
        import pytesseract
        from PIL import Image
    except ImportError as exc:  # pragma: no cover - 환경 의존
        res.warnings.append(f"OCR 불가: {exc} (pip install pytesseract pillow)")
        res.status = "scanned"
        return [p.get_text("text") or "" for p in doc]

    import io

    fitz = _pymupdf()
    out = []
    zoom = fitz.Matrix(300 / 72, 300 / 72)
    for page in doc:
        pix = page.get_pixmap(matrix=zoom)
        img = Image.open(io.BytesIO(pix.tobytes("png")))
        try:
            out.append(pytesseract.image_to_string(img, lang="kor+eng"))
        except Exception as exc:  # pragma: no cover
            res.warnings.append(f"OCR 실패(p{page.number + 1}): {exc}")
            out.append("")
    res.detail = "OCR 처리됨"
    return out


# ──────────────────────────────────────────────────────────────────────────
# HWP (한글 5.0 바이너리, OLE 복합 문서)
# ──────────────────────────────────────────────────────────────────────────
HWPTAG_BEGIN = 0x10
HWPTAG_PARA_TEXT = HWPTAG_BEGIN + 51        # 67
HWPTAG_PARA_HEADER = HWPTAG_BEGIN + 50      # 66

# 한글 문서 스펙의 컨트롤 문자 분류
_CHAR_CTRL = {0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31}          # 1 wchar
_INLINE_CTRL = {4, 5, 6, 7, 8, 9, 19, 20}                          # 8 wchar
_EXTEND_CTRL = {1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23}   # 8 wchar


def iter_records(data: bytes):
    """HWP 레코드 스트림을 (tag_id, level, payload)로 순회한다."""
    pos, size = 0, len(data)
    while pos + 4 <= size:
        (header,) = struct.unpack_from("<I", data, pos)
        pos += 4
        tag_id = header & 0x3FF
        level = (header >> 10) & 0x3FF
        length = (header >> 20) & 0xFFF
        if length == 0xFFF:                     # 확장 길이
            if pos + 4 > size:
                break
            (length,) = struct.unpack_from("<I", data, pos)
            pos += 4
        if pos + length > size:
            break
        yield tag_id, level, data[pos:pos + length]
        pos += length


def decode_para_text(payload: bytes) -> str:
    """PARA_TEXT 레코드(UTF-16LE + 컨트롤 문자)를 문자열로 푼다.

    일반 문자는 코드 단위를 그대로 모아 두었다가 UTF-16LE로 한 번에 디코딩한다.
    확장 한자·이모지처럼 BMP 밖 문자는 서로게이트 '쌍'으로 저장되어 있어서,
    한 칸씩 chr()로 바꾸면 짝이 깨져 UTF-8로 저장할 수 없는 문자열이 된다.
    """
    out: list[str] = []
    buf = bytearray()

    def flush():
        if buf:
            out.append(buf.decode("utf-16-le", errors="replace"))
            buf.clear()

    n = len(payload) // 2
    i = 0
    while i < n:
        (code,) = struct.unpack_from("<H", payload, i * 2)
        if code in _CHAR_CTRL:
            flush()
            if code in (10, 13):
                out.append("\n")
            i += 1
        elif code in _INLINE_CTRL or code in _EXTEND_CTRL:
            flush()
            if code == 9:               # 탭
                out.append("\t")
            i += 8                      # 컨트롤 + 파라미터 6 + 컨트롤 = 8 wchar
        else:
            buf += payload[i * 2:i * 2 + 2]
            i += 1
    flush()
    return "".join(out)


def extract_hwp(path: Path, res: Result) -> str:
    import olefile

    if not olefile.isOleFile(str(path)):
        head = path.open("rb").read(32)
        if head.startswith(b"HWP Document File V3.00"):
            raise RuntimeError("한글 3.0 이하 구버전 — 한글에서 hwp/hwpx로 다시 저장 필요")
        raise RuntimeError("HWP 5.0(OLE) 형식이 아님")

    ole = olefile.OleFileIO(str(path))
    try:
        if not ole.exists("FileHeader"):
            raise RuntimeError("FileHeader 없음 — 손상된 파일")

        header = ole.openstream("FileHeader").read()
        if not header.startswith(b"HWP Document File"):
            raise RuntimeError("HWP 시그니처 불일치")

        (flags,) = struct.unpack_from("<I", header, 36)
        compressed = bool(flags & 0x01)
        encrypted = bool(flags & 0x02)
        distributed = bool(flags & 0x04)
        if encrypted:
            raise RuntimeError("암호가 걸린 문서 (비밀번호 필요)")
        if distributed:
            raise RuntimeError("배포용 문서(DRM) — 한글에서 일반 문서로 저장 후 재시도")

        # BodyText/Section0, Section1, ... 순서대로
        sections = sorted(
            (e for e in ole.listdir() if e[0] == "BodyText" and e[-1].startswith("Section")),
            key=lambda e: int(re.sub(r"\D", "", e[-1]) or 0),
        )
        if not sections:
            raise RuntimeError("BodyText 섹션 없음")

        paras: list[str] = []
        for entry in sections:
            raw = ole.openstream("/".join(entry)).read()
            if compressed:
                raw = zlib.decompress(raw, -15)     # raw deflate
            for tag_id, _level, payload in iter_records(raw):
                if tag_id == HWPTAG_PARA_TEXT:
                    paras.append(decode_para_text(payload))
        res.pages = len(sections)
        return clean_text("\n".join(paras))
    finally:
        ole.close()


# ──────────────────────────────────────────────────────────────────────────
# HWPX / HWT (OWPML — ZIP + XML)
# ──────────────────────────────────────────────────────────────────────────
def extract_hwpx(path: Path, res: Result) -> str:
    with zipfile.ZipFile(path) as zf:
        names = [
            n for n in zf.namelist()
            if re.search(r"Contents/section\d+\.xml$", n, re.I)
        ]
        if not names:
            names = [n for n in zf.namelist() if n.lower().endswith(".xml") and "section" in n.lower()]
        if not names:
            raise RuntimeError("section XML 없음 — HWPX 구조가 아님")

        names.sort(key=lambda n: int(re.sub(r"\D", "", Path(n).stem) or 0))
        res.pages = len(names)

        chunks: list[str] = []
        for name in names:
            root = ET.fromstring(zf.read(name))
            for para in root.iter():
                tag = para.tag.rsplit("}", 1)[-1]
                if tag != "p":
                    continue
                buf: list[str] = []
                for node in para.iter():
                    ntag = node.tag.rsplit("}", 1)[-1]
                    if ntag == "t" and node.text:
                        buf.append(node.text)
                    elif ntag in ("tab",):
                        buf.append("\t")
                    elif ntag in ("lineBreak", "linesegarray"):
                        pass
                chunks.append("".join(buf))
    return clean_text("\n".join(chunks))


# ──────────────────────────────────────────────────────────────────────────
# LibreOffice 우회 (docx/doc/rtf/odt)
# ──────────────────────────────────────────────────────────────────────────
def extract_via_soffice(path: Path, res: Result, tmpdir: Path) -> str:
    import shutil
    import subprocess

    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        raise RuntimeError("LibreOffice(soffice) 없음 — 이 형식은 변환 불가")

    tmpdir.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [soffice, "--headless", "--norestore", "--convert-to", "txt:Text",
         "--outdir", str(tmpdir), str(path)],
        capture_output=True, text=True, timeout=300,
    )
    produced = tmpdir / (path.stem + ".txt")
    if not produced.exists():
        raise RuntimeError(f"soffice 변환 실패: {proc.stderr.strip()[:200]}")
    text = produced.read_text(encoding="utf-8", errors="replace")
    produced.unlink(missing_ok=True)
    return clean_text(text)


# ──────────────────────────────────────────────────────────────────────────
# 평문 텍스트 (인코딩 정규화)
# ──────────────────────────────────────────────────────────────────────────
def extract_plain(path: Path, res: Result) -> str:
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "utf-8", "cp949", "euc-kr", "utf-16"):
        try:
            return clean_text(raw.decode(enc))
        except UnicodeDecodeError:
            continue
    res.warnings.append("인코딩 자동판별 실패 — 손실 허용 디코딩")
    return clean_text(raw.decode("cp949", errors="replace"))


# ──────────────────────────────────────────────────────────────────────────
# 파일 1건 처리
# ──────────────────────────────────────────────────────────────────────────
def convert_one(src: Path, in_root: Path, out_root: Path,
                ocr: bool, keep_headers: bool, min_chars: int,
                compact: bool = False, mask: bool = False,
                mask_corp: bool = False) -> Result:
    res = Result(src=str(src.relative_to(in_root)), kind=src.suffix.lower().lstrip("."))
    try:
        res.src_bytes = src.stat().st_size
    except OSError:
        pass

    ext = src.suffix.lower()
    try:
        if ext == ".pdf":
            text = extract_pdf(src, res, ocr=ocr, keep_headers=keep_headers)
        elif ext == ".hwp":
            text = extract_hwp(src, res)
        elif ext in (".hwpx", ".hwt"):
            text = extract_hwpx(src, res)
        elif ext in SOFFICE_EXT:
            text = extract_via_soffice(src, res, out_root / "._soffice_tmp")
        elif ext in (".txt", ".md"):
            text = extract_plain(src, res)
        else:
            res.status = "skipped"
            res.detail = "지원하지 않는 확장자"
            return res
    except Exception as exc:
        res.status = "error"
        res.detail = f"{type(exc).__name__}: {exc}"
        return res

    if mask:
        text, res.masked = mask_pii(text, mask_corp=mask_corp)

    if compact:                      # 빈 줄 제거 — 토큰 수를 조금 더 줄인다
        text = re.sub(r"\n{2,}", "\n", text)

    res.chars = len(text)
    if res.chars < min_chars and res.status == "ok":
        res.status = "empty"
        res.detail = res.detail or f"추출 글자 수 {res.chars}자 — 스캔본이거나 빈 문서일 수 있음"

    rel = src.relative_to(in_root).with_suffix(".txt")
    dst = out_root / rel
    dst.parent.mkdir(parents=True, exist_ok=True)

    header = f"# 출처: {src.relative_to(in_root)}\n\n" if text else ""
    dst.write_text(header + text + "\n", encoding="utf-8", errors="replace")
    res.dst = str(rel)
    res.out_bytes = dst.stat().st_size
    return res


# ──────────────────────────────────────────────────────────────────────────
# 병합 / 청크 분할
# ──────────────────────────────────────────────────────────────────────────
def merge_outputs(results: list[Result], out_root: Path, chunk_mb: float) -> list[Path]:
    """개별 TXT를 하나로 합치고, 필요하면 N MB 단위로 나눈다."""
    usable = [r for r in results if r.dst and r.chars > 0]
    usable.sort(key=lambda r: r.src)

    limit = int(chunk_mb * 1024 * 1024) if chunk_mb > 0 else 0
    written: list[Path] = []
    idx, buf, size = 1, [], 0

    def flush():
        nonlocal buf, size, idx
        if not buf:
            return
        name = "merged.txt" if limit == 0 else f"merged_{idx:02d}.txt"
        p = out_root / name
        p.write_text("".join(buf), encoding="utf-8", errors="replace")
        written.append(p)
        idx += 1
        buf, size = [], 0

    for r in usable:
        body = (out_root / r.dst).read_text(encoding="utf-8", errors="replace")
        block = f"\n\n===== FILE: {r.src} =====\n\n{body}"
        blen = len(block.encode("utf-8"))
        if limit and size + blen > limit and buf:
            flush()
        buf.append(block)
        size += blen
    flush()
    return written


# ──────────────────────────────────────────────────────────────────────────
# main
# ──────────────────────────────────────────────────────────────────────────
def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f}{unit}" if unit != "B" else f"{n}B"
        n /= 1024
    return f"{n}B"


def main(argv: list[str] | None = None) -> int:
    # 윈도우 명령 프롬프트(cp949)에서 출력 불가 문자로 죽는 것을 막는다
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except Exception:
            pass

    ap = argparse.ArgumentParser(
        description="PDF/HWP/HWPX 판례 문서를 TXT로 일괄 변환",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("-i", "--input", required=True, help="원본 폴더 (하위 폴더 포함)")
    ap.add_argument("-o", "--output", required=True, help="TXT 저장 폴더")
    ap.add_argument("-j", "--workers", type=int, default=min(8, (os.cpu_count() or 2)),
                    help="병렬 처리 프로세스 수 (기본: CPU 수, 최대 8)")
    ap.add_argument("--ocr", action="store_true",
                    help="텍스트 레이어 없는 스캔 PDF를 OCR (tesseract + kor 필요, 매우 느림)")
    ap.add_argument("--keep-headers", action="store_true",
                    help="PDF 반복 머리말/꼬리말을 지우지 않음")
    ap.add_argument("--merge", action="store_true", help="전체를 하나의 TXT로도 합치기")
    ap.add_argument("--chunk-mb", type=float, default=0,
                    help="--merge 시 N MB 단위로 분할 (0이면 한 파일)")
    ap.add_argument("--mask", action="store_true",
                    help="당사자 실명·주소·주민번호 등 개인정보를 가림 "
                         "(상표명·법인명·사건번호는 그대로 둠)")
    ap.add_argument("--mask-corp", action="store_true",
                    help="--mask 와 함께, 당사자 법인명까지 [법인]으로 가림")
    ap.add_argument("--compact", action="store_true",
                    help="빈 줄까지 모두 제거해 용량을 더 줄임 (문단 구분은 사라짐)")
    ap.add_argument("--min-chars", type=int, default=50,
                    help="이 글자 수 미만이면 '내용 없음'으로 표시 (기본 50)")
    args = ap.parse_args(argv)

    in_root = Path(args.input).expanduser().resolve()
    out_root = Path(args.output).expanduser().resolve()
    if not in_root.is_dir():
        print(f"[!] 입력 폴더가 없습니다: {in_root}", file=sys.stderr)
        print(f"    현재 위치: {Path.cwd()}", file=sys.stderr)
        cand = Path.cwd()
        n = sum(1 for p in cand.rglob("*") if p.suffix.lower() in SUPPORTED_EXT)
        if n:
            print(f"    힌트: 지금 있는 폴더 안에 변환 대상 {n}개가 보입니다. "
                  f'-i "{cand}" 처럼 전체 경로를 적어보세요.', file=sys.stderr)
        return 2
    out_root.mkdir(parents=True, exist_ok=True)

    files = sorted(
        p for p in in_root.rglob("*")
        if p.is_file() and p.suffix.lower() in SUPPORTED_EXT
        and not p.name.startswith("~$") and out_root not in p.parents
    )
    if not files:
        print(f"[!] 변환할 파일이 없습니다: {in_root}", file=sys.stderr)
        return 1

    print(f"[i] 대상 {len(files)}개 · 워커 {args.workers}개 · 출력 {out_root}")
    results: list[Result] = []

    def report(r: Result, n: int):
        mark = {"ok": "[OK]", "empty": "[??]", "scanned": "[SCAN]",
                "skipped": "[--]", "error": "[FAIL]"}[r.status]
        extra = f"  {r.detail}" if r.detail else ""
        print(f"  {mark} [{n}/{len(files)}] {r.src} → {r.chars:,}자{extra}")

    if args.workers > 1:
        with ProcessPoolExecutor(max_workers=args.workers) as pool:
            futs = {
                pool.submit(convert_one, f, in_root, out_root,
                            args.ocr, args.keep_headers, args.min_chars,
                            args.compact, args.mask, args.mask_corp): f
                for f in files
            }
            for n, fut in enumerate(as_completed(futs), 1):
                try:
                    r = fut.result()
                except Exception as exc:      # 워커에서 죽어도 나머지는 계속 처리
                    bad_file = futs[fut]
                    r = Result(src=str(bad_file.relative_to(in_root)),
                               kind=bad_file.suffix.lower().lstrip("."),
                               status="error", detail=f"{type(exc).__name__}: {exc}")
                results.append(r)
                report(r, n)
    else:
        for n, f in enumerate(files, 1):
            try:
                r = convert_one(f, in_root, out_root, args.ocr, args.keep_headers,
                                args.min_chars, args.compact, args.mask, args.mask_corp)
            except Exception as exc:
                r = Result(src=str(f.relative_to(in_root)), kind=f.suffix.lower().lstrip("."),
                           status="error", detail=f"{type(exc).__name__}: {exc}")
            results.append(r)
            report(r, n)

    results.sort(key=lambda r: r.src)

    # 변환 결과표
    manifest = out_root / "_manifest.csv"
    with manifest.open("w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["원본", "결과", "형식", "상태", "비고", "원본bytes", "TXTbytes",
                    "글자수", "페이지", "마스킹"])
        for r in results:
            w.writerow([r.src, r.dst, r.kind, r.status,
                        "; ".join([r.detail] + r.warnings).strip("; "),
                        r.src_bytes, r.out_bytes, r.chars, r.pages,
                        " ".join(f"{k}{v}" for k, v in sorted(r.masked.items()))])

    merged_files: list[Path] = []
    if args.merge:
        merged_files = merge_outputs(results, out_root, args.chunk_mb)

    tmp = out_root / "._soffice_tmp"
    if tmp.is_dir() and not any(tmp.iterdir()):
        tmp.rmdir()

    src_total = sum(r.src_bytes for r in results)
    out_total = sum(r.out_bytes for r in results)
    ok = sum(r.status == "ok" for r in results)
    bad = [r for r in results if r.status in ("error", "empty", "scanned")]

    print("\n" + "-" * 60)
    print(f"완료: {ok}/{len(results)}개 정상")
    print(f"용량: {human(src_total)} → {human(out_total)}"
          f" ({(out_total / src_total * 100) if src_total else 0:.1f}%)")
    print(f"총 글자수: {sum(r.chars for r in results):,}자"
          f" (대략 {sum(r.chars for r in results) // 2:,} 토큰 내외)")
    if args.mask:
        total: dict[str, int] = {}
        for r in results:
            for k, v in r.masked.items():
                total[k] = total.get(k, 0) + v
        summary = ", ".join(f"{k} {v}건" for k, v in sorted(total.items())) or "해당 없음"
        print(f"마스킹: {summary}")
    if merged_files:
        print("병합 파일: " + ", ".join(f"{p.name}({human(p.stat().st_size)})" for p in merged_files))
    print(f"결과표: {manifest}")
    if bad:
        print(f"\n확인 필요 {len(bad)}건:")
        for r in bad:
            print(f"  - [{r.status}] {r.src}: {r.detail}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
