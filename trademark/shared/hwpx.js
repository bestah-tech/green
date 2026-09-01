// HWPX 생성기 — K-SUITE k-notice의 hwpx.js를 TRADEMARK용 ES 모듈로 옮긴 것
// 외부 라이브러리 없이 ZIP 읽기/쓰기와 OWPML(XML) 치환을 직접 수행한다.
// assets/base.hwpx 템플릿의 {{K_NOTICE_BODY}} 표식 문단을 본문으로 교체하는 방식.
// 심사관의 HWPX 샘플을 받으면 assets/base.hwpx 를 그 서식으로 교체한다.

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder('utf-8');
  const HWP_NS = Object.freeze({
    paragraph: 'http://www.hancom.co.kr/hwpml/2011/paragraph',
    head: 'http://www.hancom.co.kr/hwpml/2011/head',
    core: 'http://www.hancom.co.kr/hwpml/2011/core'
  });
  const HWPX_DEFAULT_FONT_FACE = '굴림';
  const HWPX_DEFAULT_FONT_HEIGHT = 1100;
  const HWPX_FONT_REFERENCE_LANGUAGES = Object.freeze([
    'hangul',
    'latin',
    'hanja',
    'japanese',
    'other',
    'symbol',
    'user'
  ]);

  function readU16(view, offset) {
    return view.getUint16(offset, true);
  }

  function readU32(view, offset) {
    return view.getUint32(offset, true);
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('이 브라우저는 HWPX 압축 해제를 지원하지 않습니다.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function readZip(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    const minimum = Math.max(0, bytes.length - 65557);
    for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
      if (readU32(view, offset) === 0x06054b50) {
        eocd = offset;
        break;
      }
    }
    if (eocd < 0) throw new Error('유효한 HWPX ZIP 구조를 찾지 못했습니다.');

    const entryCount = readU16(view, eocd + 10);
    const centralOffset = readU32(view, eocd + 16);
    let cursor = centralOffset;
    const entries = [];

    for (let index = 0; index < entryCount; index += 1) {
      if (readU32(view, cursor) !== 0x02014b50) throw new Error('HWPX 중앙 디렉터리가 손상되었습니다.');
      const method = readU16(view, cursor + 10);
      const compressedSize = readU32(view, cursor + 20);
      const fileNameLength = readU16(view, cursor + 28);
      const extraLength = readU16(view, cursor + 30);
      const commentLength = readU16(view, cursor + 32);
      const localOffset = readU32(view, cursor + 42);
      const nameBytes = bytes.slice(cursor + 46, cursor + 46 + fileNameLength);
      const name = textDecoder.decode(nameBytes);

      if (readU32(view, localOffset) !== 0x04034b50) throw new Error(`HWPX 항목을 읽지 못했습니다: ${name}`);
      const localNameLength = readU16(view, localOffset + 26);
      const localExtraLength = readU16(view, localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.slice(dataStart, dataStart + compressedSize);
      let data;
      if (method === 0) data = compressed;
      else if (method === 8) data = await inflateRaw(compressed);
      else throw new Error(`지원하지 않는 HWPX 압축 방식입니다: ${method}`);

      entries.push({ name, data });
      cursor += 46 + fileNameLength + extraLength + commentLength;
    }
    return entries;
  }

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      }
      table[index] = value >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let index = 0; index < bytes.length; index += 1) {
      crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    return {
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
    };
  }

  function writeU16(target, offset, value) {
    new DataView(target.buffer).setUint16(offset, value, true);
  }

  function writeU32(target, offset, value) {
    new DataView(target.buffer).setUint32(offset, value >>> 0, true);
  }

  function concatBytes(parts) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    parts.forEach((part) => {
      output.set(part, offset);
      offset += part.length;
    });
    return output;
  }

  function writeZip(rawEntries) {
    const entries = [...rawEntries].sort((left, right) => {
      if (left.name === 'mimetype') return -1;
      if (right.name === 'mimetype') return 1;
      return 0;
    });
    const localParts = [];
    const centralParts = [];
    const timestamp = dosDateTime();
    let localOffset = 0;

    entries.forEach((entry) => {
      const nameBytes = textEncoder.encode(entry.name);
      const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length);
      writeU32(local, 0, 0x04034b50);
      writeU16(local, 4, 20);
      writeU16(local, 6, 0x0800);
      writeU16(local, 8, 0);
      writeU16(local, 10, timestamp.time);
      writeU16(local, 12, timestamp.date);
      writeU32(local, 14, crc);
      writeU32(local, 18, data.length);
      writeU32(local, 22, data.length);
      writeU16(local, 26, nameBytes.length);
      writeU16(local, 28, 0);
      local.set(nameBytes, 30);
      localParts.push(local, data);

      const central = new Uint8Array(46 + nameBytes.length);
      writeU32(central, 0, 0x02014b50);
      writeU16(central, 4, 20);
      writeU16(central, 6, 20);
      writeU16(central, 8, 0x0800);
      writeU16(central, 10, 0);
      writeU16(central, 12, timestamp.time);
      writeU16(central, 14, timestamp.date);
      writeU32(central, 16, crc);
      writeU32(central, 20, data.length);
      writeU32(central, 24, data.length);
      writeU16(central, 28, nameBytes.length);
      writeU16(central, 30, 0);
      writeU16(central, 32, 0);
      writeU16(central, 34, 0);
      writeU16(central, 36, 0);
      writeU32(central, 38, entry.name.endsWith('/') ? 0x10 : 0);
      writeU32(central, 42, localOffset);
      central.set(nameBytes, 46);
      centralParts.push(central);
      localOffset += local.length + data.length;
    });

    const localBytes = concatBytes(localParts);
    const centralBytes = concatBytes(centralParts);
    const eocd = new Uint8Array(22);
    writeU32(eocd, 0, 0x06054b50);
    writeU16(eocd, 4, 0);
    writeU16(eocd, 6, 0);
    writeU16(eocd, 8, entries.length);
    writeU16(eocd, 10, entries.length);
    writeU32(eocd, 12, centralBytes.length);
    writeU32(eocd, 16, localBytes.length);
    writeU16(eocd, 20, 0);
    return concatBytes([localBytes, centralBytes, eocd]);
  }

  function elementsByLocalName(root, localName) {
    return Array.from(root.getElementsByTagName('*')).filter((node) => node.localName === localName);
  }

  function normalizeDocumentBlocks(documentContent) {
    if (Array.isArray(documentContent)) {
      return documentContent.map((block) => {
        if (block?.type === 'table') {
          return {
            type: 'table',
            key: String(block.key || 'comparison'),
            headers: Array.isArray(block.headers) ? block.headers.map((value) => String(value || '')) : [],
            rows: Array.isArray(block.rows)
              ? block.rows.map((row) => (Array.isArray(row) ? row.map((value) => String(value || '')) : []))
              : []
          };
        }
        return { type: 'paragraph', text: String(block?.text || '') };
      });
    }
    return String(documentContent || '').replace(/\r\n/g, '\n').split('\n').map((line) => ({ type: 'paragraph', text: line }));
  }

  function blocksToPlainText(documentContent) {
    return normalizeDocumentBlocks(documentContent).map((block) => {
      if (block.type !== 'table') return block.text;
      return [block.headers, ...block.rows].map((row) => row.join('\t')).join('\n');
    }).join('\n');
  }

  function createElement(documentXml, localName, attributes = {}) {
    const element = documentXml.createElementNS(HWP_NS.paragraph, `hp:${localName}`);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
    return element;
  }

  function createTableCell(documentXml, text, rowIndex, columnIndex, columnCount, width, height, isHeader, paragraphStyles) {
    const isCentered = isHeader || columnIndex === 0 || columnIndex === columnCount - 1;
    const cell = createElement(documentXml, 'tc', {
      name: '', header: isHeader ? 1 : 0, hasMargin: 0, protect: 0, editable: 0, dirty: 0,
      borderFillIDRef: isHeader ? 4 : 3
    });
    const subList = createElement(documentXml, 'subList', {
      id: '', textDirection: 'HORIZONTAL', lineWrap: 'BREAK', vertAlign: 'CENTER',
      linkListIDRef: 0, linkListNextIDRef: 0, textWidth: 0, textHeight: 0, hasTextRef: 0, hasNumRef: 0
    });
    const paragraph = createElement(documentXml, 'p', {
      id: 0,
      paraPrIDRef: isCentered ? paragraphStyles.center : paragraphStyles.body,
      styleIDRef: 0,
      pageBreak: 0,
      columnBreak: 0,
      merged: 0
    });
    const run = createElement(documentXml, 'run', { charPrIDRef: 0 });
    const textNode = createElement(documentXml, 't');
    textNode.textContent = String(text || ' ');
    run.appendChild(textNode);
    paragraph.appendChild(run);
    subList.appendChild(paragraph);
    cell.appendChild(subList);
    cell.appendChild(createElement(documentXml, 'cellAddr', { colAddr: columnIndex, rowAddr: rowIndex }));
    cell.appendChild(createElement(documentXml, 'cellSpan', { colSpan: 1, rowSpan: 1 }));
    cell.appendChild(createElement(documentXml, 'cellSz', { width, height }));
    cell.appendChild(createElement(documentXml, 'cellMargin', { left: 220, right: 220, top: 141, bottom: 141 }));
    return cell;
  }

  function createHwpxTable(documentXml, block, tableIndex = 0, paragraphStyles = { center: 0, body: 0 }) {
    const headers = Array.isArray(block?.headers) ? block.headers : [];
    const rows = Array.isArray(block?.rows) ? block.rows : [];
    const columnCount = Math.max(1, headers.length, ...rows.map((row) => row.length));
    const tableWidth = 42520;
    const preferred = columnCount === 4 ? [4677, 13181, 19559, 5103] : null;
    const widths = preferred || Array.from({ length: columnCount }, (_, index) => {
      const base = Math.floor(tableWidth / columnCount);
      return index === columnCount - 1 ? tableWidth - (base * (columnCount - 1)) : base;
    });
    const allRows = [headers, ...rows];
    // 최소 행 높이만 지정해 긴 셀은 내용에 따라 늘어나고 페이지 사이에서 자연스럽게 나뉘게 한다.
    const rowHeight = 282;
    const table = createElement(documentXml, 'tbl', {
      id: 1300000000 + tableIndex, zOrder: 0, numberingType: 'TABLE', textWrap: 'TOP_AND_BOTTOM',
      textFlow: 'BOTH_SIDES', lock: 0, dropcapstyle: 'None', pageBreak: 'CELL', repeatHeader: 1,
      rowCnt: allRows.length, colCnt: columnCount, cellSpacing: 0, borderFillIDRef: 3, noAdjust: 0
    });
    table.appendChild(createElement(documentXml, 'sz', {
      width: tableWidth, widthRelTo: 'ABSOLUTE', height: Math.max(rowHeight, allRows.length * rowHeight),
      heightRelTo: 'ABSOLUTE', protect: 0
    }));
    table.appendChild(createElement(documentXml, 'pos', {
      treatAsChar: 1, affectLSpacing: 0, flowWithText: 1, allowOverlap: 0, holdAnchorAndSO: 0,
      vertRelTo: 'PARA', horzRelTo: 'COLUMN', vertAlign: 'TOP', horzAlign: 'CENTER', vertOffset: 0, horzOffset: 0
    }));
    table.appendChild(createElement(documentXml, 'outMargin', { left: 0, right: 0, top: 141, bottom: 141 }));
    table.appendChild(createElement(documentXml, 'inMargin', { left: 220, right: 220, top: 141, bottom: 141 }));
    allRows.forEach((row, rowIndex) => {
      const tr = createElement(documentXml, 'tr');
      for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
        tr.appendChild(createTableCell(
          documentXml,
          row?.[columnIndex] || '',
          rowIndex,
          columnIndex,
          columnCount,
          widths[columnIndex],
          rowHeight,
          rowIndex === 0,
          paragraphStyles
        ));
      }
      table.appendChild(tr);
    });
    return table;
  }

  function stripRepeatedSectionProperties(paragraph) {
    elementsByLocalName(paragraph, 'secPr').forEach((node) => node.remove());
    elementsByLocalName(paragraph, 'ctrl').forEach((node) => node.remove());
  }

  function stripStaleLayout(paragraph) {
    // linesegarray is Hancom's cached paragraph layout. The marker template only
    // contains one line, so cloning that cache into long text makes every wrapped
    // line reuse the same baseline. Omitting it lets the HWPX reader lay out the
    // edited paragraph and table-cell text for the actual content width.
    elementsByLocalName(paragraph, 'linesegarray').forEach((node) => node.remove());
  }

  function replaceBodyMarker(xmlText, documentContent, paragraphStyles = { center: 0, body: 0 }) {
    const parser = new DOMParser();
    const documentXml = parser.parseFromString(xmlText, 'application/xml');
    const parseError = documentXml.querySelector('parsererror');
    if (parseError) throw new Error('기본 HWPX 본문 XML을 읽지 못했습니다.');

    const paragraphs = elementsByLocalName(documentXml, 'p');
    const markerParagraph = paragraphs.find((paragraph) => paragraph.textContent.includes('{{K_NOTICE_BODY}}'));
    if (!markerParagraph || !markerParagraph.parentNode) {
      throw new Error('기본 HWPX의 본문 삽입 위치를 찾지 못했습니다.');
    }

    const parent = markerParagraph.parentNode;
    const blocks = normalizeDocumentBlocks(documentContent);
    (blocks.length > 0 ? blocks : [{ type: 'paragraph', text: '' }]).forEach((block, blockIndex) => {
      const clone = markerParagraph.cloneNode(true);
      stripStaleLayout(clone);
      if (blockIndex > 0) stripRepeatedSectionProperties(clone);
      const textNodes = elementsByLocalName(clone, 't');
      if (textNodes.length === 0) throw new Error('기본 HWPX 문단에 텍스트 노드가 없습니다.');
      const markerTextNode = textNodes.find((node) => node.textContent.includes('{{K_NOTICE_BODY}}')) || textNodes[0];
      if (block.type === 'table') {
        const markerRun = markerTextNode.parentNode;
        while (markerRun.firstChild) markerRun.removeChild(markerRun.firstChild);
        markerRun.appendChild(createHwpxTable(documentXml, block, blockIndex, paragraphStyles));
        markerRun.appendChild(createElement(documentXml, 't'));
      } else {
        markerTextNode.textContent = block.text || ' ';
        textNodes.filter((node) => node !== markerTextNode).forEach((node) => { node.textContent = ''; });
      }
      parent.insertBefore(clone, markerParagraph);
    });
    parent.removeChild(markerParagraph);
    return new XMLSerializer().serializeToString(documentXml);
  }

  function ensureTableBorderFills(xmlText) {
    const parser = new DOMParser();
    const documentXml = parser.parseFromString(xmlText, 'application/xml');
    if (documentXml.querySelector('parsererror')) throw new Error('기본 HWPX 서식 XML을 읽지 못했습니다.');
    const collection = elementsByLocalName(documentXml, 'borderFills')[0];
    if (!collection) return xmlText;
    const existingIds = new Set(elementsByLocalName(collection, 'borderFill').map((node) => node.getAttribute('id')));
    const createBorderFill = (id, faceColor = '') => {
      const borderFill = documentXml.createElementNS(HWP_NS.head, 'hh:borderFill');
      Object.entries({ id, threeD: 0, shadow: 0, centerLine: 'NONE', breakCellSeparateLine: 0 })
        .forEach(([key, value]) => borderFill.setAttribute(key, String(value)));
      const slash = documentXml.createElementNS(HWP_NS.head, 'hh:slash');
      Object.entries({ type: 'NONE', Crooked: 0, isCounter: 0 }).forEach(([key, value]) => slash.setAttribute(key, String(value)));
      const backSlash = documentXml.createElementNS(HWP_NS.head, 'hh:backSlash');
      Object.entries({ type: 'NONE', Crooked: 0, isCounter: 0 }).forEach(([key, value]) => backSlash.setAttribute(key, String(value)));
      borderFill.append(slash, backSlash);
      ['leftBorder', 'rightBorder', 'topBorder', 'bottomBorder'].forEach((name) => {
        const border = documentXml.createElementNS(HWP_NS.head, `hh:${name}`);
        Object.entries({ type: 'SOLID', width: '0.12 mm', color: '#7B8794' }).forEach(([key, value]) => border.setAttribute(key, value));
        borderFill.appendChild(border);
      });
      const diagonal = documentXml.createElementNS(HWP_NS.head, 'hh:diagonal');
      Object.entries({ type: 'SOLID', width: '0.1 mm', color: '#7B8794' }).forEach(([key, value]) => diagonal.setAttribute(key, value));
      borderFill.appendChild(diagonal);
      if (faceColor) {
        const fillBrush = documentXml.createElementNS(HWP_NS.core, 'hc:fillBrush');
        const winBrush = documentXml.createElementNS(HWP_NS.core, 'hc:winBrush');
        Object.entries({ faceColor, hatchColor: '#999999', alpha: 0 }).forEach(([key, value]) => winBrush.setAttribute(key, String(value)));
        fillBrush.appendChild(winBrush);
        borderFill.appendChild(fillBrush);
      }
      return borderFill;
    };
    if (!existingIds.has('3')) collection.appendChild(createBorderFill(3));
    if (!existingIds.has('4')) collection.appendChild(createBorderFill(4, '#DDE8FF'));
    collection.setAttribute('itemCnt', String(elementsByLocalName(collection, 'borderFill').length));
    return new XMLSerializer().serializeToString(documentXml);
  }

  function ensureGlobalCharacterStyle(xmlText) {
    const parser = new DOMParser();
    const documentXml = parser.parseFromString(xmlText, 'application/xml');
    if (documentXml.querySelector('parsererror')) throw new Error('기본 HWPX 글자 서식 XML을 읽지 못했습니다.');

    const fontfaces = elementsByLocalName(documentXml, 'fontfaces')[0];
    const charProperties = elementsByLocalName(documentXml, 'charProperties')[0];
    const fonts = fontfaces ? elementsByLocalName(fontfaces, 'font') : [];
    const characterProperties = charProperties ? elementsByLocalName(charProperties, 'charPr') : [];
    if (!fontfaces || fonts.length === 0 || !charProperties || characterProperties.length === 0) {
      throw new Error('기본 HWPX의 글꼴 또는 글자 모양 정의를 찾지 못했습니다.');
    }

    fonts.forEach((font) => font.setAttribute('face', HWPX_DEFAULT_FONT_FACE));
    characterProperties.forEach((characterProperty) => {
      characterProperty.setAttribute('height', String(HWPX_DEFAULT_FONT_HEIGHT));
      elementsByLocalName(characterProperty, 'fontRef').forEach((fontReference) => {
        HWPX_FONT_REFERENCE_LANGUAGES.forEach((language) => fontReference.setAttribute(language, '0'));
      });
    });

    return new XMLSerializer().serializeToString(documentXml);
  }

  function ensureTableParagraphProperties(xmlText) {
    const parser = new DOMParser();
    const documentXml = parser.parseFromString(xmlText, 'application/xml');
    if (documentXml.querySelector('parsererror')) throw new Error('기본 HWPX 문단 서식 XML을 읽지 못했습니다.');
    const collection = elementsByLocalName(documentXml, 'paraProperties')[0];
    const paragraphProperties = collection ? elementsByLocalName(collection, 'paraPr') : [];
    const base = paragraphProperties.find((node) => node.getAttribute('id') === '0') || paragraphProperties[0];
    if (!collection || !base) throw new Error('기본 HWPX의 문단 서식 기준을 찾지 못했습니다.');

    const usedIds = new Set(paragraphProperties.map((node) => Number(node.getAttribute('id'))).filter(Number.isFinite));
    const allocateId = () => {
      let id = 0;
      while (usedIds.has(id)) id += 1;
      usedIds.add(id);
      return id;
    };
    const createTableParagraphProperty = ({ horizontal, breakNonLatinWord, condense }) => {
      const paragraphProperty = base.cloneNode(true);
      const id = allocateId();
      paragraphProperty.setAttribute('id', String(id));
      paragraphProperty.setAttribute('condense', String(condense));
      const align = elementsByLocalName(paragraphProperty, 'align')[0];
      const breakSetting = elementsByLocalName(paragraphProperty, 'breakSetting')[0];
      if (!align || !breakSetting) throw new Error('기본 HWPX의 정렬 또는 줄 나눔 속성을 찾지 못했습니다.');
      align.setAttribute('horizontal', horizontal);
      breakSetting.setAttribute('breakNonLatinWord', breakNonLatinWord);
      collection.appendChild(paragraphProperty);
      return id;
    };

    const ids = {
      center: createTableParagraphProperty({ horizontal: 'CENTER', breakNonLatinWord: 'BREAK_WORD', condense: 0 }),
      body: createTableParagraphProperty({ horizontal: 'JUSTIFY', breakNonLatinWord: 'KEEP_WORD', condense: 40 })
    };
    collection.setAttribute('itemCnt', String(elementsByLocalName(collection, 'paraPr').length));
    return { xmlText: new XMLSerializer().serializeToString(documentXml), ids };
  }

  async function buildHwpx(documentContent) {
    const response = await fetch(chrome.runtime.getURL('assets/base.hwpx'));
    if (!response.ok) throw new Error('기본 HWPX 템플릿을 불러오지 못했습니다.');
    const entries = await readZip(await response.arrayBuffer());
    const section = entries.find((entry) => /^Contents\/section\d+\.xml$/i.test(entry.name));
    if (!section) throw new Error('기본 HWPX에 본문 섹션이 없습니다.');
    let paragraphStyles = { center: 0, body: 0 };
    const header = entries.find((entry) => entry.name === 'Contents/header.xml');
    if (header) {
      const styledXml = ensureGlobalCharacterStyle(textDecoder.decode(header.data));
      const borderedXml = ensureTableBorderFills(styledXml);
      const paragraphResult = ensureTableParagraphProperties(borderedXml);
      paragraphStyles = paragraphResult.ids;
      header.data = textEncoder.encode(paragraphResult.xmlText);
    }
    const updatedXml = replaceBodyMarker(textDecoder.decode(section.data), documentContent, paragraphStyles);
    section.data = textEncoder.encode(updatedXml);
    const preview = entries.find((entry) => entry.name === 'Preview/PrvText.txt');
    if (preview) preview.data = textEncoder.encode(blocksToPlainText(documentContent));
    const packageInfo = entries.find((entry) => entry.name === 'Contents/content.hpf');
    if (packageInfo) {
      const sanitizedPackage = textDecoder.decode(packageInfo.data)
        .replace(/(<opf:title>)[\s\S]*?(<\/opf:title>)/i, '$1TRADEMARK$2')
        .replace(/(<opf:meta\s+name="(?:creator|lastsaveby)"\s+content="text">)[\s\S]*?(<\/opf:meta>)/gi, '$1$2');
      packageInfo.data = textEncoder.encode(sanitizedPackage);
    }
    return new Blob([writeZip(entries)], { type: 'application/vnd.hancom.hwpx' });
  }

  function sanitizeFilename(value) {
    return String(value || '의견제출통지서')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim() || '의견제출통지서';
  }

  async function downloadHwpx(documentContent, filename) {
    const blob = await buildHwpx(documentContent);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${sanitizeFilename(filename)}.hwpx`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }


export { buildHwpx, downloadHwpx, normalizeDocumentBlocks, blocksToPlainText };
