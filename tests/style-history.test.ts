import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyHistory, recordEffect, restoreVersion, reviseRules, summarizeEffects } from '../src/core/style-history';

const base = () => emptyHistory('s1', '短句为主。', '2026-10-18T00:00:00Z');

test('文风规则版本：内容不变不升版，改动升版并保留旧规则', () => {
  const first = reviseRules(base(), '短句为主。', '2026-10-18T01:00:00Z');
  assert.equal(first.current.version, 1);
  assert.equal(first.history.length, 0);
  const second = reviseRules(first, '短句为主，少形容词。', '2026-10-18T02:00:00Z');
  assert.equal(second.current.version, 2);
  assert.deepEqual(second.history.map(item => [item.version, item.rules]), [[1, '短句为主。']]);
  assert.throws(() => reviseRules(second, '   ', '2026-10-18T03:00:00Z'), /不能为空/u);
});

test('文风规则版本：历史有上限，恢复旧版会记为新版本', () => {
  let entry = base();
  for (let index = 0; index < 15; index++) entry = reviseRules(entry, `规则第 ${index} 版。`, `2026-10-18T00:00:0${index % 10}Z`);
  assert.equal(entry.history.length, 10, '历史版本应有上限');
  const keptVersion = entry.history[2].version;
  const restored = restoreVersion(entry, keptVersion, '2026-10-19T00:00:00Z');
  assert.equal(restored.current.version, entry.current.version + 1, '恢复也算新版本');
  const old = entry.history.find(item => item.version === keptVersion)!;
  assert.equal(restored.current.rules, old.rules);
  assert.throws(() => restoreVersion(entry, 999, '2026-10-19T00:00:00Z'), /找不到/u);
});

test('文风效果记录：保留计数指标并可汇总，备注与数值被夹紧', () => {
  let entry = base();
  entry = recordEffect(entry, { at: '2026-10-18T00:00:00Z', source: 'trial', characters: 640.4, averageSentence: 7.26, dialogueRatio: 0.42 });
  entry = recordEffect(entry, { at: '2026-10-18T01:00:00Z', source: 'chapter', characters: 300, averageSentence: 9, dialogueRatio: 2, note: ' 日常段 ' });
  assert.equal(entry.effects[0].note, '日常段');
  assert.equal(entry.effects[0].dialogueRatio, 1, '占比应夹在 0–1');
  const summary = summarizeEffects(entry)!;
  assert.equal(summary.samples, 2);
  assert.equal(summary.averageCharacters, 470);
  assert.equal(summary.averageSentence, 8.15);
  assert.equal(summarizeEffects(base()), null, '没有记录时返回 null');
});
