/* 뷰어 HTML의 파서를 추출해 샘플 덤프로 검증하는 테스트.
   실행: node test/parse_test.js */
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var root = path.join(__dirname, '..');
var html = fs.readFileSync(path.join(root, '심사점검표_정리뷰어.html'), 'utf8');
var m = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
if (!m) { console.error('script 추출 실패'); process.exit(1); }

var sandbox = { window: {}, document: null, alert: function(){}, console: console };
vm.createContext(sandbox);
vm.runInContext(m[1], sandbox);

function splitChunks(raw) {
  // importText와 동일한 분리 로직을 샌드박스에서 호출할 수 없으므로(DOM 의존)
  // 여기서는 parseCase만 단건 검증한다.
  return [raw];
}

function brief(s, n) {
  if (!s) return '(없음)';
  s = String(s).replace(/\n/g, '⏎');
  return s.length > (n || 70) ? s.substring(0, n || 70) + '…' : s;
}

function report(name, c) {
  console.log('==== ' + name + ' ====');
  console.log('출원번호   :', c.appNo);
  console.log('형식       :', c.oldFormat ? '구형' : '신형');
  console.log('표장명     :', c.markName || '(없음)');
  console.log('지정상품   :', (c.goods || []).length + '건',
    (c.goods || []).map(function(g){ return g.cls + '/' + g.code; }).join(', '));
  console.log('식별력     :', c.distinct || '(미기재)');
  console.log('식별력사유 :', brief(c.distinctReason));
  console.log('표장분석   :', brief(c.markAnalysis));
  function rows(label, arr) {
    arr = arr || [];
    console.log(label + ' : ' + arr.length + '건');
    for (var i = 0; i < arr.length; i++) {
      var r = arr[i];
      console.log('   #' + r.no + (r.bstar ? '★' : r.star ? '☆' : ' ') +
        ' [' + r.regno + '] ' + (r.date ? r.date + ' ' : '') +
        '표장=' + brief(r.mark, 30) +
        ' 코드=' + brief(r.codes, 25) +
        ' 권리자=' + brief(r.owner, 20) +
        (r.opinion ? ' 의견=' + brief(r.opinion, 40) : ''));
    }
  }
  rows('본인선행   ', c.ownPrior);
  rows('타인선등록 ', c.priorReg);
  rows('타인선출원 ', c.priorApp);
  console.log('종합의견   :', brief(c.overall));
  console.log('사용실태   :', brief(c.usage));
  console.log('기타34조   :', (c.art34 || '(미기재)'), brief(c.art34Note, 40));
  console.log('1차착수    :', brief(c.first));
  console.log('2차착수    :', brief(c.second));
  console.log('의견요약   :', brief(c.opSummary));
  console.log('최종판단   :', c.finalCall || '(미기재)');
  console.log('판단사유   :', brief(c.finalOpinion));
  console.log('');
}

var files = process.argv.slice(2);
if (!files.length) files = ['샘플_신형2021.txt', '샘플_신형2025.txt'];

files.forEach(function(f) {
  var raw = fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\r\n/g, '\n');
  var c = sandbox.parseCase(raw);
  report(f, c);
});

/* ==== 건 분리 + 구형 회귀 테스트 ==== */
var d21 = fs.readFileSync(path.join(__dirname, '샘플_신형2021.txt'), 'utf8').replace(/\r\n/g, '\n');
var d25 = fs.readFileSync(path.join(__dirname, '샘플_신형2025.txt'), 'utf8').replace(/\r\n/g, '\n');

console.log('==== splitDump: 두 건 이어붙임 (구버전 북마클릿, 구분선 없음) ====');
var chunks = sandbox.splitDump(d21 + '\n\n' + d25);
console.log('조각 수:', chunks.length);
chunks.forEach(function(ch, i){
  var c = sandbox.parseCase(ch);
  console.log('  조각' + (i+1) + ':', c.appNo, '/ 지정상품', (c.goods||[]).length + '건',
    '/ 선등록', (c.priorReg||[]).length + '건');
});

console.log('==== splitDump: [구분선] 표식 (v6.2) ====');
var chunks2 = sandbox.splitDump(d21 + '\n\n[구분선]\n\n' + d25);
console.log('조각 수:', chunks2.length,
  '→', chunks2.map(function(ch){ return sandbox.findAppNo(ch) || '(미상)'; }).join(', '));

console.log('==== 구형 라우팅 회귀 ====');
var oldDump = '출원번호 : 40-2014-0012345\n【검색결과】\n타인 선등록\n(1) 400123456(도형) 다니엘몰 G1201 홍길동\n【심사내용】\n\n[클립]\n(1) 400123456 다니엘몰 G1201 홍길동 → 유사없음\n\n[클립]\n판단의견\n등록결정\n';
var oc = sandbox.parseCase(oldDump);
console.log('형식:', oc.oldFormat ? '구형 ✓' : '신형 (오류!)', '/ 출원번호:', oc.appNo,
  '/ CLIP조각:', (oc.segs||[]).length, '/ 선등록행:', (oc.priorReg||[]).length,
  '/ 최종:', oc.finalCall || '(미기재)');

console.log('==== 구형 2004년형 (통복사 CLIP) ====');
var d04 = fs.readFileSync(path.join(__dirname, '샘플_구형2004.txt'), 'utf8').replace(/\r\n/g, '\n');
var c04 = sandbox.parseCase(d04);
console.log('형식:', c04.oldFormat ? '구형 ✓' : '신형 (오류!)', '/ 출원번호:', c04.appNo, '/ 표장명:', c04.markName);
console.log('지정상품:', (c04.goods||[]).length + '건',
  (c04.goods||[]).map(function(g){ return g.cls + '/' + g.code; }).join(' ; '));
console.log('본인선행:', (c04.ownPrior||[]).length + '건 / 타인선등록:', (c04.priorReg||[]).length + '건');
(c04.priorReg||[]).slice(0,3).forEach(function(r){
  console.log('   #' + r.no, '[' + r.regno + ']', '표장=' + r.mark, '코드=' + r.codes, '권리자=' + r.owner);
});
console.log('CLIP 조각:', (c04.segs||[]).length + '개 →',
  (c04.segs||[]).map(function(s){ var m=s.match(/^\s*【([^】]+)】/); return m?m[1]:'(무제)'; }).join(', '));
console.log('최종판단:', c04.finalCall || '(미기재)');
