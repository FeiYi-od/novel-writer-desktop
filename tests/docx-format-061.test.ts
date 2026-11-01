import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { formatDocxParagraphs, bodyParagraphTexts, topLevelParagraphs } from '../src/main/docx-fidelity';

const paragraph = (text: string, properties = '') => `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

async function documentXml(xml: string) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document><w:body>${xml}<w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格文字</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`);
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
}

const readDocument = async (bytes: Uint8Array) => (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string');

test('首行缩进移除互斥的悬挂缩进并保留左右缩进', async () => {
  const source = await documentXml(paragraph('正文', '<w:ind w:left="720" w:right="80" w:hanging="360" w:hangingChars="100" w:firstLine="240"/>'));
  for (const value of [0, 2]) {
    const result = await formatDocxParagraphs(source, [{ index: 0, format: { firstLineChars: value } }]);
    const xml = await readDocument(result.bytes);
    const ind = xml.match(/<w:ind\b[^>]*\/>/u)?.[0] ?? '';
    assert.match(ind, /w:left="720"/u); assert.match(ind, /w:right="80"/u);
    assert.match(ind, new RegExp(`w:firstLineChars="${value * 100}"`, 'u'));
    assert.doesNotMatch(ind, /w:hanging(?:Chars)?=/u);
    if (value === 0) assert.match(ind, /w:firstLine="0"/u);
    else assert.doesNotMatch(ind, /w:firstLine=/u);
  }
});

test('自闭合段落属性可排版且原标签属性保留', async () => {
  const source = await documentXml('<w:p><w:pPr/><w:r><w:t>正文</w:t></w:r></w:p><w:p w:rsidR="12345678"/>');
  const result = await formatDocxParagraphs(source, [{ index: 0, format: { align: 'center' } }, { index: 1, format: { align: 'left' } }]);
  const xml = await readDocument(result.bytes);
  assert.match(xml, /<w:pPr><w:jc w:val="center"\/><\/w:pPr><w:r>/u);
  assert.match(xml, /<w:p w:rsidR="12345678"><w:pPr>/u);
});

test('现有非自闭合排版元素不得产生重复元素', async () => {
  const source = await documentXml(paragraph('正文', '<w:spacing w:before="40"></w:spacing>'));
  await assert.rejects(formatDocxParagraphs(source, [{ index: 0, format: { lineSpacing: 2 } }]), /不支持/u);
});

test('新属性按 Word 规范插入且保留中间属性顺序', async () => {
  const source = await documentXml(paragraph('正文', '<w:contextualSpacing/><w:rPr><w:b/></w:rPr>'));
  const result = await formatDocxParagraphs(source, [{ index: 0, format: { firstLineChars: 2, align: 'center' } }]);
  const xml = await readDocument(result.bytes);
  assert.match(xml, /<w:ind w:firstLineChars="200"\/><w:contextualSpacing\/><w:jc w:val="center"\/><w:rPr>/u);
});

test('段落排版：对齐/首行缩进/行距/段间距写入 pPr，正文文字、表格与其它部件不变', async () => {
  const source = await documentXml(paragraph('　　第一段') + paragraph('　　第二段', '<w:jc w:val="left"/>'));
  const result = await formatDocxParagraphs(source, [
    { index: 0, format: { align: 'center', firstLineChars: 0, lineSpacing: 1.5, spaceBeforePt: 6, spaceAfterPt: 3 } },
    { index: 1, format: { align: 'both', firstLineChars: 2 } }
  ]);
  assert.equal(result.changed, 2);
  const xml = await readDocument(result.bytes);
  const blocks = topLevelParagraphs(xml);
  assert.deepEqual(blocks.map(block => block.text), ['　　第一段', '　　第二段'], '文字不能被改动');
  // pPr 子元素顺序固定为 spacing → ind → jc，且 spacing 只允许一个元素。
  assert.match(xml, /<w:pPr><w:spacing w:line="360" w:lineRule="auto" w:before="120" w:after="60"\/><w:ind w:firstLineChars="0" w:firstLine="0"\/><w:jc w:val="center"\/><\/w:pPr>/u);
  assert.match(xml, /<w:pPr><w:ind w:firstLineChars="200"\/><w:jc w:val="both"\/><\/w:pPr>/u);
  assert.match(xml, /表格文字/u, '表格内容必须保留');
  assert.match(xml, /<w:tbl>/u);
});

test('段落排版：越界、重复、非法取值都拒绝，且不产生新文件', async () => {
  const source = await documentXml(paragraph('　　只有一段'));
  await assert.rejects(formatDocxParagraphs(source, [{ index: 5, format: { align: 'center' } }]), /不存在/u);
  await assert.rejects(formatDocxParagraphs(source, [{ index: 0, format: {} }, { index: 0, format: { align: 'left' } }]), /重复/u);
  await assert.rejects(formatDocxParagraphs(source, [{ index: 0, format: { lineSpacing: 9 } }]), /行距/u);
  await assert.rejects(formatDocxParagraphs(source, [{ index: 0, format: { firstLineChars: 99 } }]), /首行缩进/u);
  await assert.rejects(formatDocxParagraphs(source, [{ index: 0, format: { spaceBeforePt: -1 } }]), /间距/u);
});

test('段落排版：已有 pPr 保留其它属性，只替换同名子元素；同一段可连续排版', async () => {
  const source = await documentXml(paragraph('　　一段', '<w:keepNext/><w:jc w:val="left"/><w:rPr><w:b/></w:rPr>'));
  const first = await formatDocxParagraphs(source, [{ index: 0, format: { align: 'right' } }]);
  let xml = await readDocument(first.bytes);
  assert.match(xml, /<w:keepNext\/>/u); assert.match(xml, /<w:rPr><w:b\/><\/w:rPr>/u);
  assert.match(xml, /<w:jc w:val="right"\/>/u);
  assert.doesNotMatch(xml, /<w:jc w:val="left"\/>/u);
  const second = await formatDocxParagraphs(first.bytes, [{ index: 0, format: { lineSpacing: 2 } }]);
  xml = await readDocument(second.bytes);
  assert.match(xml, /<w:spacing w:line="480" w:lineRule="auto"\/>/u);
  assert.match(xml, /<w:jc w:val="right"\/>/u, '第二次排版不应丢掉对齐');
  assert.deepEqual(bodyParagraphTexts(xml), ['　　一段']);
});

test('段落排版：行距与段前段后合并成一个 spacing，不产生重复元素', async () => {
  const source = await documentXml(paragraph('　　一段'));
  const result = await formatDocxParagraphs(source, [{ index: 0, format: { lineSpacing: 1.5, spaceBeforePt: 6, spaceAfterPt: 3 } }]);
  const xml = await readDocument(result.bytes);
  const spacing = xml.match(/<w:spacing\b[^>]*\/>/gu) ?? [];
  assert.equal(spacing.length, 1, `只应有一个 spacing，实际：${spacing.join(' | ')}`);
  assert.match(spacing[0]!, /w:line="360"/u); assert.match(spacing[0]!, /w:before="120"/u); assert.match(spacing[0]!, /w:after="60"/u);
});

test('段落排版：已有 spacing 的其它属性保留，只覆盖本次设置的项', async () => {
  const source = await documentXml(paragraph('　　一段', '<w:spacing w:before="40"/>'));
  const result = await formatDocxParagraphs(source, [{ index: 0, format: { lineSpacing: 2 } }]);
  const xml = await readDocument(result.bytes);
  const spacing = xml.match(/<w:spacing\b[^>]*\/>/gu) ?? [];
  assert.equal(spacing.length, 1);
  assert.match(spacing[0]!, /w:before="40"/u, '原有段前间距不能丢');
  assert.match(spacing[0]!, /w:line="480"/u);
});

test('段落排版：空段落 <w:p/> 排完后仍是合法 XML，段数不变', async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document><w:body><w:p/><w:p><w:r><w:t>　　正文</w:t></w:r></w:p></w:body></w:document>');
  const source = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
  const result = await formatDocxParagraphs(source, [{ index: 0, format: { align: 'center' } }]);
  const xml = await readDocument(result.bytes);
  assert.match(xml, /<w:p><w:pPr><w:jc w:val="center"\/><\/w:pPr><\/w:p>/u, '空段落必须补齐闭标签');
  const openings = (xml.match(/<w:p[\s>]/gu) ?? []).length, closings = (xml.match(/<\/w:p>/gu) ?? []).length;
  assert.equal(openings, closings, '段落开闭标签必须配平');
  assert.deepEqual(bodyParagraphTexts(xml), ['', '　　正文']);
});
