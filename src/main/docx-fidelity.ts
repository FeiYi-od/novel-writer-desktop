import JSZip from 'jszip';
import type { DocxStructureAction, DocxStructureHeader, DocxStructureTable } from '../shared/docx-structure';

export interface RewriteResult { bytes: Uint8Array; paragraphs: number; changed: number }
const escapeXml = (value: string) => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
const validXmlCodePoint = (code: number) => code === 9 || code === 10 || code === 13 || code >= 0x20 && code <= 0xd7ff || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff;
const unescapeXml = (value: string) => value.replace(/&(lt|gt|quot|apos|amp|#x[\da-f]+|#\d+);/giu, (_match, entity: string) => {
  const named: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
  if (entity in named) return named[entity];
  const digits = entity.slice(1), code = digits[0].toLowerCase() === 'x' ? Number.parseInt(digits.slice(1), 16) : Number.parseInt(digits, 10);
  if (!Number.isSafeInteger(code) || !validXmlCodePoint(code)) throw new Error('DOCX 包含无效 XML 字符');
  return String.fromCodePoint(code);
});

/** 收集表格外最外层段落。使用真实 XML 节点，注释和 PI 中的伪标签不参与计数。 */
export function topLevelParagraphs(xml: string): { start: number; end: number; text: string }[] {
  return descendants(xmlElements(xml)).filter(node => node.name === 'w:p' && !hasAncestor(node, 'w:tbl') && !hasAncestor(node, 'w:p'))
    .map(node => ({ start: node.start, end: node.end, text: paragraphText(xml.slice(node.start, node.end)) }));
}
const ignoredXml = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>/gu;
/** XML comments/PIs are kept byte-for-byte, but never interpreted as Word text. */
function textChunks(inner: string) {
  const chunks: { text: boolean; value: string }[] = []; let cursor = 0;
  for (const match of inner.matchAll(ignoredXml)) {
    if (match.index > cursor) chunks.push({ text: true, value: inner.slice(cursor, match.index) });
    chunks.push({ text: false, value: match[0] }); cursor = match.index + match[0].length;
  }
  if (cursor < inner.length) chunks.push({ text: true, value: inner.slice(cursor) });
  return chunks;
}
function decodedText(value: string) {
  if (/&(?!lt;|gt;|quot;|apos;|amp;|#x[\da-fA-F]+;|#\d+;)/u.test(value)) throw new Error('DOCX 包含无效 XML 实体');
  for (const character of value) if (!validXmlCodePoint(character.codePointAt(0)!)) throw new Error('DOCX 包含无效 XML 字符');
  return unescapeXml(value);
}
function nodeText(xml: string, node: XmlElement) {
  if (node.children.length) throw new Error('DOCX 文字节点包含不支持的子元素');
  return textChunks(xml.slice(node.openEnd, node.closeStart)).filter(chunk => chunk.text).map(chunk => decodedText(chunk.value)).join('');
}
function paragraphText(block: string) {
  return descendants(xmlElements(block)).filter(node => node.name === 'w:t').map(node => nodeText(block, node)).join('');
}
/** 只改文字、不动结构：保留段落属性、图片、表格、页眉页脚、样式等所有其它部件。 */
export function rewriteParagraphText(block: string, text: string): string {
  if (paragraphText(block) === text) return block;
  const nodes = descendants(xmlElements(block));
  if (nodes.some(node => /^w:(?:txbxContent|fldChar|instrText|del|ins)$/u.test(node.name))) throw new Error('该段含文本框、域或修订痕迹，无法安全改写，请用 Word/WPS 编辑原稿');
  const texts = nodes.filter(node => node.name === 'w:t');
  if (texts.length) {
    let output = '', cursor = 0;
    texts.forEach((node, index) => {
      const replacement = index === 0 ? escapeXml(text) : '';
      let open = block.slice(node.start, node.openEnd), inner = '', inserted = false;
      if (index === 0) open = open.replace(/\s+xml:space\s*=\s*(?:"[^"]*"|'[^']*')/gu, '').replace(/\s*\/?\s*>$/u, ' xml:space="preserve">');
      else open = open.replace(/\s*\/>$/u, '>');
      for (const chunk of textChunks(block.slice(node.openEnd, node.closeStart))) {
        if (!chunk.text) inner += chunk.value;
        else if (!inserted) { inner += replacement; inserted = true; }
      }
      if (!inserted) inner += replacement;
      output += block.slice(cursor, node.start) + open + inner + '</w:t>'; cursor = node.end;
    });
    return output + block.slice(cursor);
  }
  const run = `<w:r>${firstRunStyle(block)}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
  if (/^<w:p(?:\s[^>]*)?\s*\/>$/u.test(block)) return block.replace(/\s*\/>$/u, `>${run}</w:p>`);
  return block.replace(/<\/w:p>\s*$/u, `${run}</w:p>`);
}
export function bodyParagraphTexts(documentXml: string) { return topLevelParagraphs(documentXml).map(item => item.text); }

function firstRunStyle(block: string) {
  const run = descendants(xmlElements(block)).find(node => node.name === 'w:r'), style = run?.children.find(node => node.name === 'w:rPr');
  return style ? block.slice(style.start, style.end) : '';
}
function newParagraph(template: string, text: string) {
  const paragraph = xmlElements(template).find(node => node.name === 'w:p'), style = paragraph?.children.find(node => node.name === 'w:pPr');
  let properties = '';
  if (style) {
    let cursor = style.start;
    for (const section of descendants([style]).filter(node => node.name === 'w:sectPr' && !hasAncestor(node, 'w:sectPr'))) { properties += template.slice(cursor, section.start); cursor = section.end; }
    properties += template.slice(cursor, style.end);
  }
  // 只复制样式，不复制图片、书签、段落 ID、域或修订内容。
  return `<w:p>${properties}<w:r>${firstRunStyle(template)}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

/** 用新正文替换外部 DOCX 的段落文字。默认要求段落数一致；开启 structural 后才允许增删段落
 * （新增段落复制最后一个段落的样式模板，删除只从尾部去掉，绝不动表格与图片）。 */
export async function rewriteDocxParagraphs(bytes: Uint8Array, paragraphs: string[], options: { structural?: boolean } = {}): Promise<RewriteResult> {
  const zip = await JSZip.loadAsync(bytes);
  const entry = zip.file('word/document.xml');
  if (!entry) throw new Error('这不是可编辑的 Word 文档（缺少 word/document.xml）');
  const xml = await entry.async('string');
  const blocks = topLevelParagraphs(xml);
  if (blocks.length !== paragraphs.length) {
    if (!options.structural) throw new Error(`段落数不一致（原文 ${blocks.length} 段，当前 ${paragraphs.length} 段），已取消保存以免破坏原稿`);
    if (!blocks.length) throw new Error('原文没有可参照的正文段落，无法安全插入新段落');
    if (Math.abs(blocks.length - paragraphs.length) > 200) throw new Error('段落增删过多，已取消保存以免破坏原稿');
  }
  const paired = Math.min(blocks.length, paragraphs.length);
  if (blocks.slice(paired).some(block => descendants(xmlElements(xml.slice(block.start, block.end))).some(node => /^w:(?:drawing|pict|object|sectPr|bookmarkStart|bookmarkEnd|commentRangeStart|commentRangeEnd|commentReference|footnoteReference|endnoteReference|fldChar|instrText|del|ins)$/u.test(node.name)))) {
    throw new Error('待删除的段落含图片、节属性、书签或其他关联内容，无法安全删除，请用 Word/WPS 编辑原稿');
  }
  let changed = 0, output = '', cursor = 0;
  for (let index = 0; index < paired; index++) {
    const block = blocks[index]!;
    const nextText = paragraphs[index] ?? '';
    output += xml.slice(cursor, block.start);
    output += rewriteParagraphText(xml.slice(block.start, block.end), nextText);
    cursor = block.end;
    if (nextText !== block.text) changed += 1;
  }
  if (paragraphs.length > paired) {
    const template = blocks[paired - 1]!;
    output += paragraphs.slice(paired).map(text => newParagraph(xml.slice(template.start, template.end), text)).join('');
    changed += paragraphs.length - paired;
  }
  // 删除段落：只移除多出来的 <w:p> 本身，段之间的表格/图片等元素原样保留
  // （整段截断会把表格一起吞掉；不删则会出现"删了段保存后还在"）。
  let tail = cursor;
  if (paragraphs.length < blocks.length) {
    const removed = blocks.slice(paired);
    let position = cursor;
    for (const block of removed) {
      output += xml.slice(position, block.start);
      position = block.end;
      changed += 1;
    }
    tail = position;
  }
  output += xml.slice(tail);
  zip.file('word/document.xml', output);
  const result = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  // 返回值必须反映实际剩下的段数（删段时 blocks.length 是旧值）。
  return { bytes: result, paragraphs: paragraphs.length, changed };
}


export interface TableInfo { index: number; rows: number; cellsPerRow: number[]; preview: string }
interface XmlElement { name: string; start: number; openEnd: number; closeStart: number; end: number; children: XmlElement[]; parent?: XmlElement }
/** A bounded lexical tree keeps exact source offsets; edited XML never goes
 * through a serializer that could silently rewrite unrelated Word parts. */
function xmlElements(xml: string): XmlElement[] {
  const roots: XmlElement[] = [], stack: XmlElement[] = []; let position = 0, count = 0;
  while (position < xml.length) {
    const start = xml.indexOf('<', position); if (start < 0) break;
    if (xml.startsWith('<!--', start)) { const end = xml.indexOf('-->', start + 4); if (end < 0) throw new Error('DOCX XML 注释未闭合'); position = end + 3; continue; }
    if (xml.startsWith('<?', start)) { const end = xml.indexOf('?>', start + 2); if (end < 0) throw new Error('DOCX XML 声明未闭合'); position = end + 2; continue; }
    if (xml.startsWith('<!', start)) throw new Error('DOCX 包含不支持的 XML 声明或 CDATA，请用 Word/WPS 处理');
    let end = start + 1, quote = '';
    for (; end < xml.length; end++) { const char = xml[end]; if (quote) { if (char === quote) quote = ''; } else if (char === '"' || char === "'") quote = char; else if (char === '>') break; }
    if (end === xml.length) throw new Error('DOCX XML 标签未闭合'); end++;
    const tag = xml.slice(start, end), match = /^<(\/?)([A-Za-z_][\w.:-]*)(?:\s[^<>]*?)?\s*\/?>$/u.exec(tag);
    if (!match) throw new Error('DOCX XML 标签结构不受支持');
    if (match[1]) { const node = stack.pop(); if (!node || node.name !== match[2] || /^<\/[^>]*\/>$/u.test(tag)) throw new Error('DOCX XML 标签嵌套损坏'); node.closeStart = start; node.end = end; }
    else {
      if (++count > 200000 || stack.length > 100) throw new Error('DOCX XML 结构过大或层级过深');
      const node: XmlElement = { name: match[2], start, openEnd: end, closeStart: end, end, children: [], parent: stack.at(-1) };
      (node.parent?.children ?? roots).push(node); if (!/\/\s*>$/u.test(tag)) stack.push(node);
    }
    position = end;
  }
  if (stack.length) throw new Error('DOCX XML 元素未闭合'); return roots;
}
function descendants(nodes: XmlElement[]): XmlElement[] { return nodes.flatMap(node => [node, ...descendants(node.children)]); }
function tableNodes(xml: string) {
  const roots = xmlElements(xml);
  if (roots.length !== 1 || roots[0].name !== 'w:document' || roots[0].children.filter(child => child.name === 'w:body').length !== 1) throw new Error('DOCX 正文根结构损坏，请用 Word/WPS 处理');
  return descendants(roots).filter(node => node.name === 'w:tbl' && !hasAncestor(node, 'w:tbl'));
}
function hasAncestor(node: XmlElement, name: string): boolean { for (let parent = node.parent; parent; parent = parent.parent) if (parent.name === name) return true; return false; }
const unsupportedProperty = /^w:(?:gridSpan|gridBefore|gridAfter|wBefore|wAfter|vMerge|hMerge|cellMerge|sectPr|tblPrEx|(?:\w+)?Change|ins|del|moveFrom|moveTo|customXml|sdt|drawing|pict|object|fldChar|fldSimple|instrText|bookmarkStart|bookmarkEnd|commentRangeStart|commentRangeEnd|commentReference|footnoteReference|endnoteReference|altChunk|txbxContent|subDoc)$/u;
function styleSafe(node: XmlElement) { return descendants([node]).every(child => child.name.startsWith('w:') && !unsupportedProperty.test(child.name) && !['w:p', 'w:r', 'w:t', 'w:tbl', 'w:tr', 'w:tc'].includes(child.name)); }
function plainParagraph(node: XmlElement) {
  return node.name === 'w:p' && node.children.every(child => child.name === 'w:pPr' ? styleSafe(child) : child.name === 'w:r' && child.children.every(run => run.name === 'w:rPr' ? styleSafe(run) : run.name === 'w:t' && run.children.length === 0));
}
function tableReason(node: XmlElement) {
  const all = descendants([node]);
  if (all.some(child => child !== node && child.name === 'w:tbl')) return '包含嵌套表格，请用 Word/WPS 编辑';
  if (all.some(child => unsupportedProperty.test(child.name))) return '包含合并单元格、域、修订或关联对象，请用 Word/WPS 编辑';
  if (node.parent?.name !== 'w:body') return '表格不在正文直接层，无法安全编辑';
  if (node.children.some(child => !['w:tblPr', 'w:tblGrid', 'w:tr'].includes(child.name))) return '包含不支持的表格结构';
  if (node.children.filter(child => ['w:tblPr', 'w:tblGrid'].includes(child.name)).some(child => !styleSafe(child))) return '表格属性包含不支持的结构';
  const rows = node.children.filter(child => child.name === 'w:tr');
  if (!rows.length || rows.length > 1000) return '表格行数为空或超过1000行';
  let width = 0, cells = 0;
  for (const row of rows) {
    if (row.children.some(child => child.name !== 'w:tc' && (child.name !== 'w:trPr' || !styleSafe(child)))) return '表格行包含不支持的对象';
    const columns = row.children.filter(child => child.name === 'w:tc'); cells += columns.length;
    if (!width) width = columns.length;
    if (!width || columns.length !== width || cells > 10000) return '仅支持不超过10000格的规则平面表格';
    for (const cell of columns) {
      if (cell.children.some(child => child.name !== 'w:p' && (child.name !== 'w:tcPr' || !styleSafe(child)))) return '单元格包含非纯段落对象';
      const paragraphs = cell.children.filter(child => child.name === 'w:p');
      if (!paragraphs.length || paragraphs.length > 200 || paragraphs.some(child => !plainParagraph(child))) return '单元格含复杂内容或段落超过200段，请用 Word/WPS 编辑';
    }
  }
  const grid = node.children.find(child => child.name === 'w:tblGrid');
  if (grid && (grid.children.some(child => child.name !== 'w:gridCol') || grid.children.length !== width)) return '表格网格与单元格数量不一致';
  return undefined;
}
export function structureTables(xml: string): DocxStructureTable[] {
  const nodes = tableNodes(xml); if (nodes.length > 1000) throw new Error('DOCX 表格超过1000个');
  return nodes.map((node, index) => {
    const reason = tableReason(node); return { index, editable: reason === undefined, reason, rows: node.children.filter(child => child.name === 'w:tr').map((row, rowIndex) => ({ index: rowIndex,
      cells: row.children.filter(child => child.name === 'w:tc').map((cell, cellIndex) => ({ index: cellIndex, editable: reason === undefined, reason,
        paragraphs: cell.children.filter(child => child.name === 'w:p').map(paragraph => paragraphText(xml.slice(paragraph.start, paragraph.end))) })) })) };
  });
}
export function structureHeader(xml: string, part: string): DocxStructureHeader {
  const roots = xmlElements(xml), root = roots.length === 1 ? roots[0] : undefined;
  const paragraphs = root?.children.filter(node => node.name === 'w:p') ?? [];
  const editable = Boolean(root && ['w:hdr', 'w:ftr'].includes(root.name) && paragraphs.length > 0 && paragraphs.length <= 10000 && root.children.every(plainParagraph));
  return { part, paragraphs: paragraphs.map(node => paragraphText(xml.slice(node.start, node.end))), editable, reason: editable ? undefined : '页眉页脚含表格、域、图片、修订或其他复杂结构，请用 Word/WPS 编辑' };
}
/** 读取文档里的表格概况（只读视图，用于界面展示，不改动文件）。 */
export function listTables(xml: string): TableInfo[] {
  return structureTables(xml).map(table => ({ index: table.index, rows: table.rows.length, cellsPerRow: table.rows.map(row => row.cells.length), preview: table.rows[0]?.cells.flatMap(cell => cell.paragraphs).join(' | ').slice(0, 80) ?? '' }));
}
function editTableXml(xml: string, action: Exclude<DocxStructureAction, { kind: 'header' }>) {
  const table = tableNodes(xml)[action.tableIndex]; if (!table) throw new Error(`第 ${action.tableIndex + 1} 个表格不存在`);
  const reason = tableReason(table); if (reason) throw new Error(reason);
  const rows = table.children.filter(node => node.name === 'w:tr');
  if (action.kind === 'appendRow') {
    if (rows.length >= 1000) throw new Error('表格最多1000行');
    if ((rows.length + 1) * rows[0].children.filter(node => node.name === 'w:tc').length > 10000) throw new Error('表格最多10000个单元格');
    const template = rows.at(-1)!, properties = template.children.find(node => node.name === 'w:trPr');
    const added = `<w:tr>${properties ? xml.slice(properties.start, properties.end) : ''}${template.children.filter(node => node.name === 'w:tc').map(cell => {
      const cellProperties = cell.children.find(node => node.name === 'w:tcPr');
      return `<w:tc>${cellProperties ? xml.slice(cellProperties.start, cellProperties.end) : ''}${cell.children.filter(node => node.name === 'w:p').map(node => newParagraph(xml.slice(node.start, node.end), '')).join('')}</w:tc>`;
    }).join('')}</w:tr>`;
    return { xml: xml.slice(0, table.closeStart) + added + xml.slice(table.closeStart), changed: 1 };
  }
  const row = rows[action.rowIndex]; if (!row) throw new Error(`第 ${action.rowIndex + 1} 行不存在`);
  if (action.kind === 'removeRow') { if (rows.length <= 1) throw new Error('表格至少保留一行'); return { xml: xml.slice(0, row.start) + xml.slice(row.end), changed: 1 }; }
  const cell = row.children.filter(node => node.name === 'w:tc')[action.cellIndex]; if (!cell) throw new Error(`第 ${action.cellIndex + 1} 个单元格不存在`);
  if (!action.paragraphs.length || action.paragraphs.length > 200) throw new Error('单元格需要1至200个段落');
  const paragraphs = cell.children.filter(node => node.name === 'w:p'); let output = '', cursor = cell.start, changed = 0;
  for (let index = 0; index < paragraphs.length; index++) {
    const node = paragraphs[index]; output += xml.slice(cursor, node.start);
    if (index < action.paragraphs.length) { output += rewriteParagraphText(xml.slice(node.start, node.end), action.paragraphs[index]); if (paragraphText(xml.slice(node.start, node.end)) !== action.paragraphs[index]) changed++; }
    else changed++;
    cursor = node.end;
  }
  if (action.paragraphs.length > paragraphs.length) { const template = paragraphs.at(-1)!; output += action.paragraphs.slice(paragraphs.length).map(text => newParagraph(xml.slice(template.start, template.end), text)).join(''); changed += action.paragraphs.length - paragraphs.length; }
  output += xml.slice(cursor, cell.end);
  return { xml: xml.slice(0, cell.start) + output + xml.slice(cell.end), changed };
}
function editHeaderXml(xml: string, action: Extract<DocxStructureAction, { kind: 'header' }>) {
  const safety = structureHeader(xml, action.part); if (!safety.editable) throw new Error(safety.reason);
  const blocks = topLevelParagraphs(xml); if (action.paragraphs.length > blocks.length) throw new Error('页眉段落数不足，已取消改写');
  let output = '', cursor = 0, changed = 0;
  blocks.forEach((block, index) => { const next = action.paragraphs[index]; if (next === undefined) return; output += xml.slice(cursor, block.start) + rewriteParagraphText(xml.slice(block.start, block.end), next); cursor = block.end; if (next !== block.text) changed++; });
  return { xml: output + xml.slice(cursor), changed, paragraphs: blocks.length };
}
/** All actions run against one ZIP in memory; publish is the service's job. */
export async function editDocxStructure(bytes: Uint8Array, actions: DocxStructureAction[]) {
  const zip = await JSZip.loadAsync(bytes), parts = new Map<string, string>(); let changed = 0;
  for (const action of actions) {
    const part = action.kind === 'header' ? action.part : 'word/document.xml';
    if (!parts.has(part)) {
      const entry = zip.file(part); if (!entry) throw new Error(`文档里没有 ${part}`);
      let xml: string; try { xml = new TextDecoder('utf-8', { fatal: true }).decode(await entry.async('uint8array')); } catch { throw new Error('DOCX XML 不是有效 UTF-8，请用 Word/WPS 处理'); }
      parts.set(part, xml);
    }
    const result = action.kind === 'header' ? editHeaderXml(parts.get(part)!, action) : editTableXml(parts.get(part)!, action);
    parts.set(part, result.xml); changed += result.changed;
  }
  for (const [name, xml] of parts) zip.file(name, xml);
  return { bytes: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }), changed };
}
/** 在指定表格末尾追加一行：复制最后一行的样式模板，清空单元格文字。 */
export async function appendTableRow(bytes: Uint8Array, tableIndex: number) {
  return editDocxStructure(bytes, [{ kind: 'appendRow', tableIndex }]);
}
/** 删除指定表格的某一行；不允许把表格删空。 */
export async function removeTableRow(bytes: Uint8Array, tableIndex: number, rowIndex: number) {
  return editDocxStructure(bytes, [{ kind: 'removeRow', tableIndex, rowIndex }]);
}
/** 改写页眉/页脚文字（段落结构保持不变），其它部件不动。 */
export async function rewriteHeaderTexts(bytes: Uint8Array, partName: string, paragraphs: string[]) {
  const zip = await JSZip.loadAsync(bytes);
  const entry = zip.file(partName);
  if (!entry) throw new Error(`文档里没有 ${partName}`);
  const result = editHeaderXml(await entry.async('string'), { kind: 'header', part: partName, paragraphs }); zip.file(partName, result.xml);
  return { bytes: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }), changed: result.changed, paragraphs: result.paragraphs };
}

/** 列出文档里的图片（word/media/*），供界面选择替换目标。 */
export async function listImages(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  return Object.values(zip.files).filter(entry => !entry.dir && /^word\/media\//u.test(entry.name))
    .map(entry => ({ name: entry.name, bytes: (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0 }));
}
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };
/** 用新图片替换指定图片部件；扩展名变化时同步补上 [Content_Types].xml 的 Default 声明。 */
export async function replaceImage(bytes: Uint8Array, mediaName: string, image: Uint8Array) {
  if (!/^word\/media\/[^\u0000]+\.[a-z0-9]+$/iu.test(mediaName)) throw new Error('只能替换 word/media 下的图片');
  const zip = await JSZip.loadAsync(bytes);
  if (!zip.file(mediaName)) throw new Error(`文档里没有 ${mediaName}`);
  zip.file(mediaName, image);
  const extension = (mediaName.split('.').pop() ?? '').toLowerCase();
  const types = zip.file('[Content_Types].xml');
  if (types && MIME[extension]) {
    const xml = await types.async('string');
    if (!new RegExp(`Extension="${extension}"`, 'iu').test(xml)) {
      const declaration = `<Default Extension="${extension}" ContentType="${MIME[extension]}"/>`;
      zip.file('[Content_Types].xml', xml.includes('</Types>') ? xml.replace('</Types>', `${declaration}</Types>`) : xml.replace(/<Types\s*\/>/u, `<Types>${declaration}</Types>`));
    }
  }
  return { bytes: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }), name: mediaName };
}
