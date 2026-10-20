import test from 'node:test';
import assert from 'node:assert/strict';
import type { RichNode } from '../src/shared/contracts';
import { applyReviewEdits, parseReview, type ReviewIssue } from '../src/core/review';
import { applyRichReviewEdits, validateReviewDocument } from '../src/core/rich-review';
import { copyableText, normalizeParagraphs, PARAGRAPH_PREFIX as prefix } from '../src/core/typography';

const text = (value: string, ...styles: string[]): RichNode => ({ type: 'text', text: value, ...(styles.length ? { marks: styles.map(type => ({ type })) } : {}) });
const paragraph = (...content: RichNode[]): RichNode => ({ type: 'paragraph', content });
const heading = (level: number, ...content: RichNode[]): RichNode => ({ type: 'heading', attrs: { level }, content });
const doc = (...content: RichNode[]): RichNode => ({ type: 'doc', content });
const report = (source: string, pairs: [string, string][]): ReviewIssue[] => parseReview(JSON.stringify({ summary: '仅为虚构测试', issues: pairs.map(([quote, replacement]) => ({ category: '错别字', quote, replacement, reason: '作者核对', evidence: '' })) }), source, '').issues;
const edit = (document: RichNode, pairs: [string, string][], selected?: string[]): RichNode => {
  const source = copyableText(document), issues = report(source, pairs);
  return applyRichReviewEdits(document, source, issues, selected ?? issues.map(issue => issue.id));
};
function freeze(value: RichNode): RichNode {
  for (const child of value.content ?? []) freeze(child);
  if (value.marks) { for (const mark of value.marks) Object.freeze(mark); Object.freeze(value.marks); }
  if (value.attrs) Object.freeze(value.attrs);
  if (value.content) Object.freeze(value.content);
  return Object.freeze(value);
}

test('格式审稿：跨粗斜体片段替换，继承首字样式且未选文字/标题/空段/换行保留', () => {
  const document = freeze(doc(
    heading(2, text('虚构章名', 'italic')),
    paragraph(text('　　她推', 'bold'), text('开', 'italic'), text('们。'), text('未选尾句', 'bold', 'italic')),
    paragraph(),
    paragraph(text('保留前句'), { type: 'hardBreak' }, text('保留后句', 'italic'))
  ));
  const snapshot = structuredClone(document), normalized = normalizeParagraphs(snapshot);
  const revised = edit(document, [['推开们', '推开门']]);
  assert.deepEqual(document, snapshot);
  assert.equal(copyableText(revised), '虚构章名\n\n　　她推开门。未选尾句\n\n　　\n\n　　保留前句\n保留后句');
  assert.deepEqual(revised.content![0], normalized.content![0]);
  assert.deepEqual(revised.content![2], normalized.content![2]);
  assert.deepEqual(revised.content![3], normalized.content![3]);
  assert.deepEqual(revised.content![1].content, [text('　　她', 'bold'), text('推开门', 'bold'), text('。'), text('未选尾句', 'bold', 'italic')]);
});

test('格式审稿：多个段落和同段倒序修订，保留段落顺序及未选建议', () => {
  const document = doc(heading(1, text('错误标题')), paragraph(text('错误甲，中间未选，错误乙。', 'italic')), heading(3, text('尾标题')));
  const source = copyableText(document), issues = report(source, [['错误标题', '正确标题'], ['错误甲', '正确甲'], ['中间未选', '不该出现'], ['错误乙', '很长的正确乙']]);
  const revised = applyRichReviewEdits(document, source, issues, ['issue-4', 'issue-1', 'issue-2']);
  assert.equal(copyableText(revised), '正确标题\n\n　　正确甲，中间未选，很长的正确乙。\n\n尾标题');
  assert.equal(copyableText(revised), applyReviewEdits(source, issues, ['issue-4', 'issue-1', 'issue-2']));
  assert.deepEqual(revised.content!.map(block => [block.type, block.attrs?.level]), [['heading', 1], ['paragraph', undefined], ['heading', 3]]);
  assert.ok(revised.content![1].content!.every(run => run.marks?.[0].type === 'italic'));
});

test('格式审稿：Unicode 使用 UTF-16 定位，完整 emoji 与首尾删除保留样式', () => {
  const document = doc(paragraph(text('首😀中', 'bold'), text('尾', 'italic')), paragraph(text('另一段')));
  const revised = edit(document, [['首', ''], ['😀', '🌙星'], ['尾', '']]);
  assert.equal(copyableText(revised), '　　🌙星中\n\n　　另一段');
  assert.deepEqual(revised.content![0].content, [text(prefix, 'bold'), text('🌙星', 'bold'), text('中', 'bold')]);
});

test('格式审稿：删除一段全部正文或全部标题文字，保留空段/空标题', () => {
  const document = doc(heading(3, text('删除标题', 'italic')), paragraph(text('删除正文', 'bold')), paragraph(text('保留正文')));
  const revised = edit(document, [['删除标题', ''], ['删除正文', '']]);
  assert.equal(copyableText(revised), `\n\n${prefix}\n\n${prefix}保留正文`);
  assert.equal(revised.content!.length, 3);
  assert.deepEqual(revised.content![0], heading(3));
  assert.equal(revised.content![1].content!.map(run => run.text).join(''), prefix);
  assert.deepEqual(revised.content![2], normalizeParagraphs(document).content![2]);
});

test('格式审稿：替换第一字沿用该字样式，后续 run 与换行保持', () => {
  const document = doc(paragraph(text('甲', 'italic'), text('乙', 'bold'), { type: 'hardBreak' }, text('丙')));
  const revised = edit(document, [['甲', '丁丁']]);
  assert.deepEqual(revised.content![0].content, [text(prefix, 'italic'), text('丁丁', 'italic'), text('乙', 'bold'), { type: 'hardBreak' }, text('丙')]);
});

test('格式审稿：删除首个样式片段后两格仍可复制，剩余可见文字样式不变', () => {
  const document = doc(paragraph(text('删掉', 'bold'), text('保留斜体', 'italic'), text('保留普通')));
  const revised = edit(document, [['删掉', '']]);
  assert.equal(copyableText(revised), `${prefix}保留斜体保留普通`);
  assert.deepEqual(revised.content![0].content, [text(prefix, 'bold'), text('保留斜体', 'italic'), text('保留普通')]);
  const normalized = normalizeParagraphs(revised);
  assert.deepEqual(normalized.content![0].content, [text(`${prefix}保留斜体`, 'italic'), text('保留普通')]);
});

test('格式审稿：Shift+Enter 的已支持样式保留，换行后文字独立样式不变', () => {
  const lineBreak: RichNode = { type: 'hardBreak', marks: [{ type: 'bold' }, { type: 'italic' }] };
  const document = doc(paragraph(text('前句', 'bold'), lineBreak, text('后句', 'italic')));
  const revised = edit(document, [['前句', '新前句']]);
  assert.equal(copyableText(revised), `${prefix}新前句\n后句`);
  assert.deepEqual(revised.content![0].content, [text(prefix, 'bold'), text('新前句', 'bold'), lineBreak, text('后句', 'italic')]);
  assert.deepEqual(document.content![0].content![1], lineBreak);
  assert.throws(() => validateReviewDocument(doc(paragraph({ type: 'hardBreak', marks: [{ type: 'underline' }] }))), /不支持/);
  assert.throws(() => validateReviewDocument(doc(paragraph({ type: 'hardBreak', attrs: { color: '#f00' } }))), /不支持/);
});

test('格式审稿：重叠、重复选择、失效、空正文沿用已有保护', () => {
  const document = doc(paragraph(text('这是旧文字。'))), source = copyableText(document);
  const issues = report(source, [['旧文字', '新文字'], ['这是旧文字。', '更正全文']]);
  assert.throws(() => applyRichReviewEdits(document, source, issues, ['issue-1', 'issue-2']), /重叠/);
  assert.throws(() => applyRichReviewEdits(document, source, issues, ['issue-1', 'issue-1']), /重复/);
  assert.throws(() => applyRichReviewEdits(document, source, issues, []), /请选择/);
  assert.throws(() => applyRichReviewEdits(document, source, issues, ['issue-9']), /定位/);
  const deletion = report(source, [['这是旧文字。', '']]);
  assert.throws(() => applyRichReviewEdits(document, source, deletion, ['issue-1']), /为空/);
  assert.throws(() => applyRichReviewEdits(document, `${source}已变化`, issues, ['issue-1']), /不一致/);
});

test('格式审稿：手填重复引文或非整数/伪造位置仍拒绝', () => {
  const document = doc(paragraph(text('重复重复')), paragraph(text('唯一短句'))), source = copyableText(document);
  const issue = { id: 'issue-1', category: '错别字', quote: '重复', replacement: '改句', reason: '测试', evidence: '', start: 2, limitation: '' };
  assert.throws(() => applyRichReviewEdits(document, source, [issue], ['issue-1']), /唯一/);
  assert.throws(() => applyRichReviewEdits(document, source, [{ ...issue, quote: '', start: 0 }], ['issue-1']), /唯一/);
  assert.throws(() => applyRichReviewEdits(document, source, [{ ...issue, start: NaN }], ['issue-1']), /定位/);
  assert.throws(() => applyRichReviewEdits(document, source, [{ ...issue, start: 2.5 }], ['issue-1']), /定位/);
});

test('格式审稿：不允许跨段/硬换行或在替换文字中新增换行', () => {
  const document = doc(paragraph(text('前句'), { type: 'hardBreak' }, text('后句')), paragraph(text('下一段'))), source = copyableText(document);
  const base = { id: 'issue-1', category: '错别字', reason: '测试', evidence: '', limitation: '' };
  for (const [quote, replacement] of [['前句\n后句', '连句'], ['后句\n\n　　下一段', '连段'], ['前句', '新\n句'], ['前句', '新\r句']]) {
    assert.throws(() => applyRichReviewEdits(document, source, [{ ...base, quote, replacement, start: source.indexOf(quote) }], ['issue-1']), /跨段|换行/);
  }
});

test('格式审稿：两个真实全角空格不可替换，规范化改变替换文字时拒绝', () => {
  const document = doc(paragraph(text('正文')), paragraph(text('留存'))), source = copyableText(document);
  const issues = report(source, [['　　正文', '　　新正文']]);
  assert.throws(() => applyRichReviewEdits(document, source, issues, ['issue-1']), /全角空格/);
  assert.throws(() => edit(document, [['正文', ' 新正文']]), /规范化/);
  assert.throws(() => edit(document, [['正文', '　　新正文']]), /规范化/);
  assert.equal(copyableText(edit(document, [['正文', '新正文']])), '　　新正文\n\n　　留存');
});

test('格式审稿：禁止 UTF-16 代理项中间切开，也拒绝损坏的替换字符', () => {
  const document = doc(paragraph(text('😀原句')), paragraph(text('保留内容'))), source = copyableText(document);
  const base = { id: 'issue-1', category: '错别字', reason: '测试', evidence: '', limitation: '' };
  for (const quote of ['\ud83d', '\ude00']) {
    assert.throws(() => applyRichReviewEdits(document, source, [{ ...base, quote, replacement: '字', start: source.indexOf(quote) }], ['issue-1']), /Unicode/);
  }
  assert.throws(() => edit(document, [['原句', '\ud83d']]), /Unicode/);
  assert.throws(() => edit(document, [['原句', '\ude00']]), /Unicode/);
});

test('文档准备：深克隆并规范化，允许空属性和无意义空值，不改输入', () => {
  const document = freeze({ ...doc(paragraph(text(' \t　', 'bold'), text('正文', 'italic')), heading(1)), attrs: {} });
  const value = validateReviewDocument(document, `${prefix}正文\n\n`);
  assert.equal(copyableText(value), `${prefix}正文\n\n`);
  assert.deepEqual(value.content![0].content, [text(`${prefix}正文`, 'italic')]);
  assert.notEqual(value, document); assert.notEqual(value.content, document.content);
  const emptyAttrs = doc({ ...paragraph(text('文字')), attrs: { ignored: null } });
  assert.doesNotThrow(() => validateReviewDocument(emptyAttrs));
  assert.equal(document.content![0].content![0].text, ' \t　');
});

test('文档准备：未知段落/内嵌节点或标题级别拒绝', () => {
  for (const document of [doc({ type: 'blockquote', content: [paragraph(text('句'))] }), doc(paragraph({ type: 'image', attrs: { src: 'x' } })), doc(heading(4, text('标题'))), doc({ ...heading(1, text('标题')), attrs: { level: '1' } }), { type: 'doc', content: [] }]) {
    assert.throws(() => validateReviewDocument(document), /不支持|仅支持|无效/);
  }
});

test('文档准备：未支持且有意义的属性/样式不能由 DOCX 编码静默丢失', () => {
  const examples: RichNode[] = [
    { ...doc(paragraph(text('句'))), attrs: { title: '保留标题' } },
    doc({ ...paragraph(text('句')), attrs: { textAlign: 'center' } }),
    doc({ ...heading(2, text('句')), attrs: { level: 2, color: '#f00' } }),
    doc(paragraph({ ...text('句'), attrs: { color: '#f00' } })),
    doc(paragraph(text('句', 'underline'))),
    doc(paragraph({ ...text('句'), marks: [{ type: 'bold', attrs: { color: 'red' } } as { type: string }] })),
    doc(paragraph({ ...text('句'), marks: [{ type: 'bold' }, { type: 'bold' }] })),
    doc(paragraph({ type: 'hardBreak', marks: [{ type: 'underline' }] })),
    doc(paragraph({ type: 'hardBreak', text: '隐藏内容' })),
    doc({ ...paragraph(text('句')), text: '隐藏内容' }),
    doc(paragraph({ ...text('句'), content: [text('隐藏内容')] }))
  ];
  for (const document of examples) assert.throws(() => validateReviewDocument(document), /不支持|无效/);
});

test('文档准备：损坏结构/文字/原始换行/拆开 emoji 的 run 拒绝', () => {
  const examples: unknown[] = [null, { type: 'doc', content: null }, doc({ type: 'paragraph', content: '内容' as never }), doc(paragraph({ type: 'text', text: 1 as never })), doc(paragraph({ type: 'text', text: '一\n二' })), doc(paragraph(text('\ud83d'), text('\ude00'))), doc(paragraph({ ...text('内容'), attrs: [] as never })), doc(paragraph({ ...text('内容'), marks: 'bold' as never }))];
  for (const document of examples) assert.throws(() => validateReviewDocument(document as RichNode), /无效|不支持/);
});

test('格式审稿：多个相邻修改不吞掉相邻样式，字面替换不解析格式', () => {
  const document = doc(paragraph(text('甲', 'bold'), text('乙', 'italic'), text('丙')));
  const revised = edit(document, [['甲', '<b>新</b>'], ['乙', '😀']]);
  assert.equal(copyableText(revised), '　　<b>新</b>😀丙');
  assert.deepEqual(revised.content![0].content, [text(prefix, 'bold'), text('<b>新</b>', 'bold'), text('😀', 'italic'), text('丙')]);
});
