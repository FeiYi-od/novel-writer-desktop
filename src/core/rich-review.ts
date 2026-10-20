import type { RichNode } from '../shared/contracts';
import { applyReviewEdits, type ReviewIssue } from './review';
import { copyableText, normalizeParagraphs, PARAGRAPH_PREFIX } from './typography';

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function supportedKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.entries(value).some(([key, item]) => !allowed.includes(key) && item != null)) {
    throw new Error('存在尚不支持的文档结构或格式，不能保留格式采纳');
  }
}

function attrs(value: unknown, heading = false): void {
  if (value == null) { if (heading) throw new Error('仅支持 1—3 级标题'); return; }
  if (!record(value)) throw new Error('文档属性格式无效');
  supportedKeys(value, heading ? ['level'] : []);
  if (heading && ![1, 2, 3].includes(value.level as number)) throw new Error('仅支持 1—3 级标题');
}

function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function marks(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error('文字样式格式无效');
  const seen = new Set<string>();
  for (const mark of value) {
    if (!record(mark) || !['bold', 'italic'].includes(mark.type as string) || seen.has(mark.type as string)) {
      throw new Error('存在尚不支持的文字样式，不能保留格式采纳');
    }
    supportedKeys(mark, ['type', 'attrs']); attrs(mark.attrs); seen.add(mark.type as string);
  }
}

/** Accept only the editor/DOCX encoder's supported subset. Return a detached,
 * normalized document; never let a text-only match hide unsupported formatting. */
export function validateReviewDocument(document: RichNode, source?: string): RichNode {
  let cloned: RichNode;
  try { cloned = structuredClone(document); }
  catch { throw new Error('文档结构无效，不能保留格式采纳'); }
  if (!record(cloned) || cloned.type !== 'doc' || !Array.isArray(cloned.content)
    || !cloned.content.length || cloned.content.length > 100000) throw new Error('文档结构无效');
  supportedKeys(cloned, ['type', 'attrs', 'content']); attrs(cloned.attrs);
  for (const block of cloned.content) {
    if (!record(block) || !['paragraph', 'heading'].includes(block.type as string)) {
      throw new Error('存在尚不支持的段落结构，不能保留格式采纳');
    }
    supportedKeys(block, ['type', 'attrs', 'content']); attrs(block.attrs, block.type === 'heading');
    if (block.content !== undefined && !Array.isArray(block.content)) throw new Error('段落内容格式无效');
    for (const run of block.content ?? []) {
      if (!record(run) || !['text', 'hardBreak'].includes(run.type as string)) {
        throw new Error('存在尚不支持的段落内容，不能保留格式采纳');
      }
      supportedKeys(run, run.type === 'text' ? ['type', 'text', 'attrs', 'marks'] : ['type', 'attrs', 'marks']);
      attrs(run.attrs); marks(run.marks);
      if (run.type === 'text') {
        if (typeof run.text !== 'string' || /[\r\n]/u.test(run.text) || !wellFormed(run.text)) {
          throw new Error('文字内容或换行格式无效，不能保留格式采纳');
        }
      }
    }
  }
  const normalized = normalizeParagraphs(cloned);
  if (source !== undefined && copyableText(normalized) !== source) {
    throw new Error('文档结构与送审正文不一致，请重新审稿');
  }
  return normalized;
}

function splitsSurrogate(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1), after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function replaceInBlock(block: RichNode, start: number, end: number, replacement: string): void {
  let offset = 0, inserted = false;
  const next: RichNode[] = [];
  for (const run of block.content ?? []) {
    const length = run.type === 'hardBreak' ? 1 : run.text!.length;
    const runEnd = offset + length;
    if (runEnd <= start || offset >= end) next.push(run);
    else {
      if (run.type !== 'text') throw new Error('跨换行修改需手工处理');
      if (start > offset) next.push({ ...run, text: run.text!.slice(0, start - offset) });
      if (!inserted) {
        // Every replacement character inherits the first matched character's marks.
        if (replacement) next.push({ ...run, text: replacement });
        inserted = true;
      }
      if (end < runEnd) next.push({ ...run, text: run.text!.slice(end - offset) });
    }
    offset = runEnd;
  }
  if (!inserted) throw new Error('选中建议没有有效文档定位');
  block.content = next;
}

/** Apply selected unique, single-line review spans to a cloned rich document.
 * Global offsets are UTF-16, as in parseReview; block separators are two LFs. */
export function applyRichReviewEdits(document: RichNode, source: string, issues: ReviewIssue[], selected: string[]): RichNode {
  const result = validateReviewDocument(document, source);
  const expected = applyReviewEdits(source, issues, selected);
  const chosen = selected.map(id => issues.find(issue => issue.id === id)!)
    .sort((a, b) => b.start! - a.start!);
  const blocks = result.content!.map(block => {
    const text = (block.content ?? []).map(run => run.type === 'hardBreak' ? '\n' : run.text!).join('');
    return { block, text, start: 0 };
  });
  let offset = 0;
  for (const block of blocks) { block.start = offset; offset += block.text.length + 2; }
  for (const issue of chosen) {
    const start = issue.start!, end = start + issue.quote.length;
    if (!Number.isSafeInteger(start) || start < 0 || !issue.quote || issue.limitation
      || source.indexOf(issue.quote) !== start || source.indexOf(issue.quote, start + 1) >= 0) {
      throw new Error('选中建议没有唯一有效原文定位');
    }
    if (/[\r\n]/u.test(issue.quote + issue.replacement)) throw new Error('跨段或换行修改需手工处理');
    if (splitsSurrogate(source, start) || splitsSurrogate(source, end) || !wellFormed(issue.replacement)) {
      throw new Error('修改边界或替换文字拆分了 Unicode 字符');
    }
    const target = blocks.find(block => start >= block.start && end <= block.start + block.text.length);
    if (!target) throw new Error('选中建议没有有效文档定位');
    const localStart = start - target.start;
    if (target.block.type === 'paragraph' && localStart < PARAGRAPH_PREFIX.length) {
      throw new Error('段首两个全角空格必须保留，请只修改正文文字');
    }
    replaceInBlock(target.block, localStart, end - target.start, issue.replacement);
  }
  if (copyableText(result) !== expected) {
    throw new Error('段首规范化会改变修订文字，请调整建议后重新审稿');
  }
  return result;
}
