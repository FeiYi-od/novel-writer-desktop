import test from 'node:test';
import assert from 'node:assert/strict';
import { compareStyleVariants, measureStyle, textOverlap } from '../src/core/style-compare';

test('文风测量：字数/句数/段落/平均句长/对白占比', () => {
  const text = '“走吧。”她说。\n雨落在北门上，声音很轻。';
  const metrics = measureStyle(text);
  assert.equal(metrics.paragraphs, 2);
  assert.equal(metrics.sentences, 3, "引号内的句号也算一次断句");
  assert.ok(metrics.dialogueRatio > 0 && metrics.dialogueRatio < 0.5, `对白占比应小于一半，实际 ${metrics.dialogueRatio}`);
  assert.ok(metrics.averageSentence > 0);
  assert.deepEqual(measureStyle(''), { chars: 0, sentences: 0, paragraphs: 0, averageSentence: 0, dialogueRatio: 0 });
});

test('文风相似度：相同文本为 1，完全不同为 0，部分重合介于之间', () => {
  assert.equal(textOverlap('雨落在北门', '雨落在北门'), 1);
  assert.equal(textOverlap('甲乙丙丁', '子丑寅卯'), 0);
  const partial = textOverlap('雨落在北门上，很轻', '雨落在北门上');
  assert.ok(partial > 0 && partial < 1, `部分重合应在 0–1 之间，实际 ${partial}`);
});

test('文风比较：指出最不同的一版与最接近的一对，结果稳定', () => {
  const comparison = compareStyleVariants([
    { styleId: 'a', styleName: '冷峻', text: '雨落在北门上，很轻。她走了。' },
    { styleId: 'b', styleName: '冷峻（改写）', text: '雨落在北门上，很轻。她走了。' },
    { styleId: 'c', styleName: '华丽', text: '雨丝如织，金光泼洒，众人惊叹不已，心潮翻涌难息。' }
  ]);
  assert.equal(comparison.mostDistinct, 'c');
  assert.deepEqual(comparison.mostSimilar, ['a', 'b']);
  assert.equal(comparison.rows.find(row => row.styleId === 'a')!.overlapWithOthers > comparison.rows.find(row => row.styleId === 'c')!.overlapWithOthers, true);
  const again = compareStyleVariants([
    { styleId: 'a', styleName: '冷峻', text: '雨落在北门上，很轻。她走了。' },
    { styleId: 'b', styleName: '冷峻（改写）', text: '雨落在北门上，很轻。她走了。' },
    { styleId: 'c', styleName: '华丽', text: '雨丝如织，金光泼洒，众人惊叹不已，心潮翻涌难息。' }
  ]);
  assert.deepEqual(again, comparison, '相同输入必须给出相同结果');
  assert.equal(compareStyleVariants([{ styleId: 'a', styleName: '唯一', text: 'x' }]).mostDistinct, null);
});
