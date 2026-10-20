import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { analyzeDocx } from '../src/main/docx-capabilities';
import { encodeDocx } from '../src/main/docx';
import { textDocument } from '../src/main/text-import';

async function zipOf(parts: Record<string, string>) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(parts)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('能力报告：普通 DOCX 只保留正文与段落，并说明文本排版会被重写', async () => {
  const bytes = await encodeDocx(textDocument('第一段。\n第二段。'));
  const report = await analyzeDocx(bytes);
  assert.equal(report.preservedText, true);
  assert.equal(report.features[0].feature, '正文文字与段落');
  assert.equal(report.features[0].preserved, true);
  assert.match(report.features[0].note, /宋体五号/u);
});

test('能力报告：逐项列出图片、表格、页眉、脚注等不会保留的元素及数量', async () => {
  const bytes = await zipOf({
    'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p><w:tbl/><w:drawing/><w:hyperlink/><w:sectPr/>'
      + '<w:p><w:r><w:footnoteReference w:id="1"/></w:r></w:p></w:body></w:document>',
    'word/header1.xml': '<w:hdr><w:p><w:r><w:t>页眉</w:t></w:r></w:p></w:hdr>',
    'word/footnotes.xml': '<w:footnotes><w:footnote w:id="1"/></w:footnotes>'
  });
  const report = await analyzeDocx(bytes);
  const names = report.features.filter(item => !item.preserved).map(item => item.feature);
  assert.deepEqual(names.sort(), ['图片', '分节', '表格', '页眉/页脚', '脚注/尾注引用', '超链接'].sort());
  const header = report.features.find(item => item.feature === '页眉/页脚');
  assert.ok(header, '页眉引用应被报告');
  assert.ok(report.risks.some(text => /图片 ×1/u.test(text)), '风险列表要带数量');
});

test('能力报告：缺少 document.xml 的文件明确报错，不假装能打开', async () => {
  const bytes = await zipOf({ 'word/header1.xml': '<w:hdr/>' });
  await assert.rejects(analyzeDocx(bytes), /不是有效的 DOCX/u);
});
