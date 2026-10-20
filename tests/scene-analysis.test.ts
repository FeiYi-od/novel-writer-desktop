import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeScene, dominantTrait } from '../src/core/scene-analysis';

test('场景分析：对白为主的场景识别正确，并给出针对性建议', () => {
  const text = '“你来了。”她说。\n“嗯。”\n“雨很大。”她低声道。\n“我知道。”';
  const report = analyzeScene(text);
  assert.equal(report.metrics.type, 'dialogue');
  assert.ok(report.metrics.dialogueRatio >= 0.35);
  assert.ok(Array.isArray(report.suggestions), '建议始终是数组');
  assert.match(dominantTrait(report.metrics), /对白/u);
  const tagged = analyzeScene('“你来了。”她说道。\n“嗯。”他答道。\n“雨很大。”她说道。');
  assert.ok(tagged.suggestions.some(item => item.includes('说道')), '提示语过密应被指出');
});

test('场景分析：动作场景看动作句与段落长度', () => {
  const text = '他冲向门口，撞开门板。雨扑了进来。他挥刀劈向黑影，侧身躲过一击，抬脚踢翻木架。';
  const report = analyzeScene(text);
  assert.equal(report.metrics.type, 'action');
  assert.ok(report.metrics.actionSentences >= 3);
  assert.match(dominantTrait(report.metrics), /动作推进/u);
});

test('场景分析：日常长段与模糊词、状语过多都会被点名', () => {
  const report = analyzeScene('他似乎想起了什么，大概是很久以前的事，可能的细节已经模糊。' + '雨声轻轻地落下来。'.repeat(30));
  assert.ok(report.metrics.hedges >= 3);
  assert.ok(report.suggestions.some(item => item.includes('模糊词')));
  const long = analyzeScene('他把水壶放在桌上，' + '又看了看窗外的雨。'.repeat(20));
  assert.ok(long.metrics.averageParagraph > 0);
  assert.equal(analyzeScene('').metrics.chars, 0, '空文本不应报错');
});
