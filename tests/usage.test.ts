import test from 'node:test';
import assert from 'node:assert/strict';
import { addUsage, EMPTY_USAGE, formatUsage, mergeEntry, parseUsage, type UsageEntry } from '../src/core/usage';

test('用量：累加输入与输出，空用量只记调用次数', () => {
  let total = addUsage(EMPTY_USAGE, { prompt: 120, completion: 300 });
  assert.deepEqual(total, { prompt: 120, completion: 300, calls: 1 });
  total = addUsage(total, { prompt: 10.6, completion: -5 });
  assert.deepEqual(total, { prompt: 131, completion: 300, calls: 2 }, '小数取整、负数按 0');
  assert.deepEqual(addUsage(total, {}), { prompt: 131, completion: 300, calls: 3 });
});

test('用量解析：兼容 OpenAI 与 Anthropic 字段，缺失返回 null', () => {
  assert.deepEqual(parseUsage({ usage: { prompt_tokens: 12, completion_tokens: 34 } }), { prompt: 12, completion: 34 });
  assert.deepEqual(parseUsage({ type: 'message_delta', usage: { input_tokens: 7, output_tokens: 8 } }), { prompt: 7, completion: 8 });
  assert.deepEqual(parseUsage({ message: { usage: { input_tokens: 3, output_tokens: 4 } } }), { prompt: 3, completion: 4 });
  assert.equal(parseUsage({ choices: [] }), null);
  assert.equal(parseUsage({ usage: {} }), null);
  assert.equal(parseUsage(null), null);
});

test('用量汇总：同一连接同模型合并并置顶，最多保留 40 条', () => {
  const base: UsageEntry = { connectionId: 'c1', connectionName: '主模型', model: 'm', prompt: 10, completion: 20, calls: 1, updatedAt: '2026-10-18T00:00:00Z' };
  const merged = mergeEntry([base], { ...base, prompt: 5, completion: 5, calls: 1, updatedAt: '2026-10-18T02:00:00Z' });
  assert.equal(merged.length, 1);
  assert.deepEqual([merged[0].prompt, merged[0].completion, merged[0].calls], [15, 25, 2]);
  const many = Array.from({ length: 45 }, (_, index) => ({ ...base, connectionId: `c${index}`, updatedAt: `2026-10-18T00:00:${String(index % 60).padStart(2, '0')}Z` }));
  assert.equal(many.reduce<UsageEntry[]>((list, entry) => mergeEntry(list, entry), []).length, 40);
  assert.match(formatUsage({ prompt: 10, completion: 20, calls: 2 }), /2 次调用.*输入 10.*输出 20.*合计 30/u);
  assert.equal(formatUsage(EMPTY_USAGE), '还没有用量记录');
});
