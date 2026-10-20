import JSZip from 'jszip';

export interface RewriteResult { bytes: Uint8Array; paragraphs: number; changed: number }
const escapeXml = (value: string) => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
const unescapeXml = (value: string) => value.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&amp;/gu, '&');

/** 收集 body 层（表格外）的段落：按标签扫描统计 <w:tbl> 深度，避免把表格里的段落当成正文段落。 */
export function topLevelParagraphs(xml: string): { start: number; end: number; text: string }[] {
  const found: { start: number; end: number; text: string }[] = [];
  const tagPattern = /<(\/?)([A-Za-z0-9:]+)([^>]*)>/gu;
  let depth = 0, paragraphDepth = 0, openStart = -1;
  for (let match = tagPattern.exec(xml); match; match = tagPattern.exec(xml)) {
    const closing = match[1] === '/', name = match[2], tagStart = match.index, tagEnd = tagStart + match[0].length;
    const selfClosing = /\/\s*>$/u.test(match[0]);
    if (name === 'w:tbl') { if (closing) depth = Math.max(0, depth - 1); else if (!selfClosing) depth += 1; continue; }
    if (depth > 0) continue;
    if (name !== 'w:p') continue;
    if (!closing) {
      if (selfClosing) { if (!paragraphDepth) found.push({ start: tagStart, end: tagEnd, text: '' }); continue; }
      if (!paragraphDepth) openStart = tagStart;
      paragraphDepth += 1; continue;
    }
    if (openStart < 0) continue;
    paragraphDepth -= 1;
    if (paragraphDepth > 0) continue;
    const block = xml.slice(openStart, tagEnd);
    found.push({ start: openStart, end: tagEnd, text: paragraphText(block) });
    openStart = -1;
  }
  return found;
}
function paragraphText(block: string) {
  return [...block.matchAll(/<w:t(?:\s[^>]*?)?(?<!\/)>([\s\S]*?)<\/w:t>/gu)].map(item => unescapeXml(item[1] ?? '')).join('');
}
/** 只改文字、不动结构：保留段落属性、图片、表格、页眉页脚、样式等所有其它部件。 */
export function rewriteParagraphText(block: string, text: string): string {
  if (paragraphText(block) === text) return block;
  if (/<w:(?:txbxContent|fldChar|instrText|del|ins)(?:\s|\/?>)/u.test(block)) throw new Error('该段含文本框、域或修订痕迹，无法安全改写，请用 Word/WPS 编辑原稿');
  let used = false;
  const output = block.replace(/<w:t(\s[^>]*?)?(?<!\/)>([\s\S]*?)<\/w:t>/gu, (_match, attributes: string | undefined) => {
    const preserved = (attributes ?? '').replace(/\s+xml:space\s*=\s*(?:"[^"]*"|'[^']*')/gu, '') + ' xml:space="preserve"';
    if (!used) { used = true; return `<w:t${preserved}>${escapeXml(text)}</w:t>`; }
    return `<w:t${attributes ?? ''}></w:t>`;
  });
  if (used) return output;
  const run = `<w:r>${firstRunStyle(block)}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
  if (/^<w:p(?:\s[^>]*)?\s*\/>$/u.test(block)) return block.replace(/\s*\/>$/u, `>${run}</w:p>`);
  return output.replace(/<\/w:p>\s*$/u, `${run}</w:p>`);
}
export function bodyParagraphTexts(documentXml: string) { return topLevelParagraphs(documentXml).map(item => item.text); }

function firstRunStyle(block: string) {
  const run = block.match(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/u)?.[1] ?? '';
  return run.match(/<w:rPr(?:\s[^>]*)?(?:\s*\/>|>[\s\S]*?<\/w:rPr>)/u)?.[0] ?? '';
}
function newParagraph(template: string, text: string) {
  const properties = (template.match(/<w:pPr(?:\s[^>]*)?(?:\s*\/>|>[\s\S]*?<\/w:pPr>)/u)?.[0] ?? '')
    .replace(/<w:sectPr(?:\s[^>]*)?(?:\s*\/>|>[\s\S]*?<\/w:sectPr>)/gu, '');
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
  if (blocks.slice(paired).some(block => /<w:(?:drawing|pict|object|sectPr|bookmarkStart|bookmarkEnd|commentRangeStart|commentRangeEnd|commentReference|footnoteReference|endnoteReference|fldChar|instrText|del|ins)(?:\s|\/?>)/u.test(xml.slice(block.start, block.end)))) {
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
/** 读取文档里的表格概况（只读视图，用于界面展示，不改动文件）。 */
export function listTables(xml: string): TableInfo[] {
  const tables: TableInfo[] = [];
  const tablePattern = /<w:tbl>[\s\S]*?<\/w:tbl>/gu;
  let match: RegExpExecArray | null, index = 0;
  while ((match = tablePattern.exec(xml))) {
    const block = match[0];
    const rows = [...block.matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/gu)].map(row => row[0]);
    tables.push({
      index, rows: rows.length,
      cellsPerRow: rows.map(row => (row.match(/<w:tc(?:\s[^>]*)?>/gu) ?? []).length),
      preview: rows[0] ? [...rows[0].matchAll(/<w:t(?:\s[^>]*?)?(?<!\/)>([\s\S]*?)<\/w:t>/gu)].map(item => unescapeXml(item[1] ?? '')).join(' | ').slice(0, 80) : ''
    });
    index += 1;
  }
  return tables;
}
async function editDocumentXml(bytes: Uint8Array, edit: (xml: string) => { xml: string; changed: number }) {
  const zip = await JSZip.loadAsync(bytes);
  const entry = zip.file('word/document.xml');
  if (!entry) throw new Error('这不是可编辑的 Word 文档（缺少 word/document.xml）');
  const result = edit(await entry.async('string'));
  zip.file('word/document.xml', result.xml);
  return { bytes: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }), changed: result.changed };
}
/** 在指定表格末尾追加一行：复制最后一行的样式模板，清空单元格文字。 */
export async function appendTableRow(bytes: Uint8Array, tableIndex: number) {
  return editDocumentXml(bytes, xml => {
    const tables = [...xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/gu)];
    const table = tables[tableIndex];
    if (!table) throw new Error(`第 ${tableIndex + 1} 个表格不存在`);
    const rows = [...table[0].matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/gu)];
    const lastRow = rows[rows.length - 1];
    if (!lastRow) throw new Error('这个表格没有可参照的行');
    const template = lastRow[0];
    const cleared = template.replace(/<w:t(\s[^>]*?)?(?<!\/)>([\s\S]*?)<\/w:t>/gu, (_m, attributes: string | undefined) => `<w:t${attributes ?? ''}></w:t>`);
    const insertAt = table.index + table[0].lastIndexOf('</w:tbl>');
    return { xml: xml.slice(0, insertAt) + cleared + xml.slice(insertAt), changed: 1 };
  });
}
/** 删除指定表格的某一行；不允许把表格删空。 */
export async function removeTableRow(bytes: Uint8Array, tableIndex: number, rowIndex: number) {
  return editDocumentXml(bytes, xml => {
    const tables = [...xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/gu)];
    const table = tables[tableIndex];
    if (!table) throw new Error(`第 ${tableIndex + 1} 个表格不存在`);
    const rows = [...table[0].matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/gu)];
    if (rows.length <= 1) throw new Error('表格至少保留一行');
    const target = rows[rowIndex];
    if (!target) throw new Error(`第 ${rowIndex + 1} 行不存在`);
    const start = table.index + target.index;
    return { xml: xml.slice(0, start) + xml.slice(start + target[0].length), changed: 1 };
  });
}
/** 改写页眉/页脚文字（段落结构保持不变），其它部件不动。 */
export async function rewriteHeaderTexts(bytes: Uint8Array, partName: string, paragraphs: string[]) {
  const zip = await JSZip.loadAsync(bytes);
  const entry = zip.file(partName);
  if (!entry) throw new Error(`文档里没有 ${partName}`);
  const xml = await entry.async('string');
  const blocks = topLevelParagraphs(xml);
  if (!blocks.length) throw new Error('页眉里没有可改写的段落');
  if (blocks.length < paragraphs.length) throw new Error('页眉段落数不足，已取消改写');
  let output = '', cursor = 0, changed = 0;
  blocks.forEach((block, index) => {
    const nextText = paragraphs[index];
    if (nextText === undefined) return;
    output += xml.slice(cursor, block.start);
    output += rewriteParagraphText(xml.slice(block.start, block.end), nextText);
    cursor = block.end;
    if (nextText !== block.text) changed += 1;
  });
  output += xml.slice(cursor);
  zip.file(partName, output);
  return { bytes: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }), changed, paragraphs: blocks.length };
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
