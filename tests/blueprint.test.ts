import test from 'node:test';
import assert from 'node:assert/strict';
import { assertBlueprints, blueprintFor, isStale, normalizeBlueprint, type BlueprintNode } from '../src/core/blueprint';

const node = (scope: 'volume' | 'chapter', ref: string, extra: Partial<BlueprintNode> = {}): BlueprintNode =>
  normalizeBlueprint({ scope, ref, goals: '推进主线', ...extra });

test('蓝图：必须指定归属与内容，标题缺省时可读', () => {
  assert.throws(() => normalizeBlueprint({ ref: 'x', goals: 'a' }), /分卷或章节/u);
  assert.throws(() => normalizeBlueprint({ scope: 'chapter', goals: 'a' }), /选择要写蓝图/u);
  assert.throws(() => normalizeBlueprint({ scope: 'chapter', ref: 'a.docx' }), /蓝图为空/u);
  const filled = normalizeBlueprint({ scope: 'chapter', ref: 'a.docx', beats: ['  第一幕  ', ''] });
  assert.deepEqual(filled.beats, ['第一幕']);
  assert.equal(filled.title, '章节蓝图');
});

test('蓝图：同一对象只能有一份，超出上限报错', () => {
  assert.doesNotThrow(() => assertBlueprints([node('chapter', 'a.docx'), node('volume', 'a.docx')]));
  assert.throws(() => assertBlueprints([node('chapter', 'a.docx'), node('chapter', 'a.docx')]), /只能有一份/u);
  assert.throws(() => assertBlueprints(Array.from({ length: 1001 }, (_, index) => node('chapter', `c${index}.docx`))), /最多/u);
});

test('蓝图：章节来源哈希变化才算过期，分卷蓝图永不过期', () => {
  const hash = 'a'.repeat(64);
  const chapter = node('chapter', 'a.docx', { sourceHash: hash });
  assert.equal(isStale(chapter, hash), false);
  assert.equal(isStale(chapter, 'b'.repeat(64)), true, '正文改过后章节蓝图应提示过期');
  assert.equal(isStale(node('chapter', 'a.docx'), 'b'.repeat(64)), false, '没记录来源哈希时不判定过期');
  assert.equal(isStale(node('volume', 'v1'), 'b'.repeat(64)), false);
  assert.equal(blueprintFor([chapter], 'chapter', 'a.docx')?.id, chapter.id);
  assert.equal(blueprintFor([chapter], 'chapter', 'missing.docx'), null);
});
