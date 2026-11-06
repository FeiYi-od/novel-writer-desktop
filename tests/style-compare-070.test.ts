import test from 'node:test';
import assert from 'node:assert/strict';
import { compareForMerge } from '../src/core/style-merge-compare';

const style = (id: string, name: string, rules: string, metrics: Partial<{ meanSentenceLength: number; meanParagraphLength: number; dialogueRatio: number; firstPersonPerThousand: number; characters: number }> = {}) => ({
  id, name, rules,
  metrics: { meanSentenceLength: 20, meanParagraphLength: 50, dialogueRatio: 10, firstPersonPerThousand: 5, characters: 1000, ...metrics }
});

test('文风比较：共同规则与各自独有规则分开，指标区间正确', () => {
  const result = compareForMerge([
    style('a', '长篇', '共同规则\n长篇独有', { meanSentenceLength: 32, meanParagraphLength: 80, dialogueRatio: 6 }),
    style('b', '短篇', '共同规则\n短篇独有', { meanSentenceLength: 16, meanParagraphLength: 40, dialogueRatio: 28 })
  ]);
  assert.deepEqual(result.shared, ['共同规则']);
  assert.deepEqual(result.perStyle.map(item => item.unique), [['长篇独有'], ['短篇独有']]);
  assert.deepEqual(result.ranges.sentenceLength, { min: 16, max: 32 });
  assert.deepEqual(result.ranges.dialogueRatio, { min: 6, max: 28 });
});

test('文风比较：两条相同规则去重算共同，重复行不重复计数；少于两份拒绝', () => {
  const result = compareForMerge([
    style('a', '甲', '节奏\n节奏\n甲独有'),
    style('b', '乙', '节奏\n乙独有')
  ]);
  assert.deepEqual(result.shared, ['节奏']);
  assert.deepEqual(result.perStyle[0]!.unique, ['甲独有']);
  assert.throws(() => compareForMerge([style('a', '甲', 'x')]), /至少需要两份/u);
});
