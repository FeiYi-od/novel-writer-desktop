import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceInDocument } from '../src/core/replace-text';
import type { RichNode } from '../src/shared/contracts';

const doc = (...paragraphs: RichNode[][]): RichNode => ({ type: 'doc', content: paragraphs.map(content => ({ type: 'paragraph', content })) });
const texts = (node: RichNode): string[] => (node.content ?? []).flatMap(child => (child.type === 'text' ? [String(child.text)] : texts(child)));

test('整书替换：只改文本并保留标记，计数正确', () => {
  const source = doc([{ type: 'text', text: '月钥开启北门，月钥发亮。', marks: [{ type: 'bold' }] }]);
  const result = replaceInDocument(source, '月钥', '银钥');
  assert.equal(result.count, 2);
  assert.deepEqual(texts(result.document), ['银钥开启北门，银钥发亮。']);
  assert.deepEqual(result.document.content?.[0].content?.[0].marks, [{ type: 'bold' }], '标记必须保留');
});

test('整书替换：区分大小写可关闭，查找为空直接拒绝', () => {
  const source = doc([{ type: 'text', text: 'Alice 和 alice' }]);
  assert.equal(replaceInDocument(source, 'alice', 'A').count, 1);
  assert.equal(replaceInDocument(source, 'alice', 'A', { caseSensitive: false }).count, 2);
  assert.throws(() => replaceInDocument(source, '   ', 'x'), /不能为空/u);
});

test('整书替换：无命中时文档不变，超过上限即截断并标记', () => {
  const source = doc([{ type: 'text', text: '无关文字' }]);
  const none = replaceInDocument(source, '月钥', '银钥');
  assert.equal(none.count, 0);
  assert.deepEqual(none.document, source);
  const many = doc([{ type: 'text', text: '啊啊啊啊' }]);
  const limited = replaceInDocument(many, '啊', '呀', { maxPerChapter: 2 });
  assert.equal(limited.count, 2);
  assert.equal(limited.truncated, true);
  assert.deepEqual(texts(limited.document), ['呀呀啊啊'], '达到上限后剩余文字原样保留');
});
