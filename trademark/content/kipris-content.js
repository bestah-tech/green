// KIPRIS 검색결과 페이지 content script
// 사이드패널의 요청을 받아 (1) 검색결과 수집, (2) 화면 구조 캡처를 수행한다.
// 구버전 크롬 호환을 위해 import 없이 단독 파일로 작성.
//
// 수집 전략:
//   1차 - selectors.json 의 셀렉터로 수집 (내부망 반입 시 파일만 교체)
//   2차 - 셀렉터가 안 맞으면 출원번호 패턴(40-2024-0123456 등)으로 항목을 찾아
//         각 항목의 텍스트 블록을 통째로 수집 (휴리스틱 폴백)

(function () {
  // 출원/등록번호 패턴: 상표는 40~45로 시작 (4X-YYYY-NNNNNNN 또는 4XYYYYNNNNNNN)
  var APP_NO_RE = /\b(4[0-5])[-\s]?(\d{4})[-\s]?(\d{7})\b/g;

  function textOf(el) {
    return (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
  }

  // ---------- 1차: 셀렉터 기반 수집 ----------
  function collectBySelectors(selectors) {
    var conf = selectors && selectors.resultList ? selectors.resultList : {};
    if (!conf.item) return [];
    var items;
    try {
      items = document.querySelectorAll(conf.item);
    } catch (e) {
      return [];
    }
    var results = [];
    items.forEach(function (item) {
      var fields = conf.fields || {};
      function pick(sel) {
        if (!sel) return "";
        try {
          var el = item.querySelector(sel);
          return textOf(el);
        } catch (e) {
          return "";
        }
      }
      var row = {
        applicationNumber: pick(fields.applicationNumber),
        markName: pick(fields.markName),
        applicant: pick(fields.applicant),
        status: pick(fields.status),
        goodsClasses: pick(fields.goodsClasses),
        rawText: textOf(item).slice(0, 500),
        source: "selector"
      };
      if (row.applicationNumber || row.markName || row.rawText) results.push(row);
    });
    return results;
  }

  // ---------- 2차: 출원번호 휴리스틱 수집 ----------
  function collectByHeuristic() {
    var body = document.body;
    if (!body) return [];
    // 출원번호가 들어있는 요소를 찾아, 검색결과 1건에 해당하는 조상 컨테이너를 추정한다
    var walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null);
    var hits = [];
    var node;
    while ((node = walker.nextNode())) {
      var text = node.nodeValue || "";
      APP_NO_RE.lastIndex = 0;
      if (APP_NO_RE.test(text)) hits.push(node);
      if (hits.length > 300) break; // 안전 상한
    }
    var seen = new Set();
    var results = [];
    hits.forEach(function (textNode) {
      // 항목 컨테이너 추정: li / tr / article / 카드형 div 중 가장 가까운 것
      var el = textNode.parentElement;
      var container = el;
      var depth = 0;
      while (el && depth < 8) {
        var tag = el.tagName ? el.tagName.toLowerCase() : "";
        if (tag === "li" || tag === "tr" || tag === "article") {
          container = el;
          break;
        }
        // 텍스트가 충분히 많은 div 카드도 후보
        if (tag === "div" && textOf(el).length > 40) container = el;
        el = el.parentElement;
        depth += 1;
      }
      if (!container || seen.has(container)) return;
      seen.add(container);

      var raw = textOf(container).slice(0, 500);
      APP_NO_RE.lastIndex = 0;
      var match = APP_NO_RE.exec(raw);
      var appNo = match ? match[1] + "-" + match[2] + "-" + match[3] : "";
      results.push({
        applicationNumber: appNo,
        markName: "",
        applicant: "",
        status: "",
        goodsClasses: (raw.match(/(?:상품분류|분류)\s*[:：]?\s*(\d{1,2}\s*류?(?:\s*,\s*\d{1,2}\s*류?)*)/) || [, ""])[1].trim(),
        rawText: raw,
        source: "heuristic"
      });
    });
    return results;
  }

  // ---------- 화면 구조 캡처 (셀렉터 확정용 개발 도우미) ----------
  // 출원번호가 들어있는 첫 항목 주변의 HTML 원문을 잘라서 반환한다.
  function captureStructure() {
    var sample = "";
    var heuristics = collectByHeuristic();
    if (heuristics.length > 0) {
      // 첫 결과 항목의 컨테이너 HTML (속성 포함) 을 잘라낸다
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      var node;
      while ((node = walker.nextNode())) {
        APP_NO_RE.lastIndex = 0;
        if (APP_NO_RE.test(node.nodeValue || "")) {
          var el = node.parentElement;
          var depth = 0;
          while (el && depth < 8) {
            var tag = el.tagName ? el.tagName.toLowerCase() : "";
            if (tag === "li" || tag === "tr" || tag === "article") break;
            el = el.parentElement;
            depth += 1;
          }
          if (el) sample = el.outerHTML.slice(0, 8000);
          break;
        }
      }
    }
    return {
      url: location.href,
      title: document.title,
      itemCount: heuristics.length,
      sampleItemHtml: sample || "(출원번호 패턴이 있는 항목을 찾지 못했습니다 — 검색결과 화면에서 다시 시도해 주세요)"
    };
  }

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (!message) return false;
    if (message.type === "TM_COLLECT_RESULTS") {
      try {
        var bySel = collectBySelectors(message.selectors);
        var results = bySel.length > 0 ? bySel : collectByHeuristic();
        if (results.length === 0) {
          // 프레임 기반 화면(특허넷)에서는 이 스크립트가 모든 프레임에 떠 있고,
          // 첫 응답이 채택된다. 빈 프레임은 늦게 답해서 결과 있는 프레임에 양보한다.
          setTimeout(function () {
            sendResponse({ ok: true, results: [], url: location.href });
          }, 400);
        } else {
          sendResponse({ ok: true, results: results, url: location.href });
        }
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
      return true;
    }
    if (message.type === "TM_CAPTURE_STRUCTURE") {
      try {
        sendResponse({ ok: true, capture: captureStructure() });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
      return true;
    }
    return false;
  });
})();
