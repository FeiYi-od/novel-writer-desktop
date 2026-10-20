import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryUsage } from '../src/core/memory-budget';
import type { StoryFact, StoryMemoryEntry } from '../src/shared/contracts';

const fact = (id: string, text: string, extra: Partial<StoryFact> = {}): StoryFact =>
  ({ id, projectId: 'p', kind: 'fact', text, state: 'open', enabled: true, createdAt: '2026-10-17T00:00:00.000Z', ...extra });
const entry = (id: string, content: string, extra: Partial<StoryMemoryEntry> = {}): StoryMemoryEntry =>
  ({ id, projectId: 'p', sourcePath: `${id}.docx`, sourceHash: 'a'.repeat(64), content, taskId: 't', model: 'm', createdAt: '2026-10-17T00:00:00.000Z', enabled: true, important: false, ...extra });

test('预算统计与上下文顺序一致：事实先占位，超预算整条跳过', () => {
  const value = { schemaVersion: 1 as const, projectId: 'p', budgetBytes: 120, facts: [fact('f1', '月钥只能开启北门'), fact('f2', 'x'.repeat(200), { kind: 'foreshadow' })], entries: [entry('e1', '摘要内容')] };
  const usage = memoryUsage(value, []);
  assert.equal(usage.budget, 120);
  assert.equal(usage.includedFacts, 1); assert.equal(usage.skippedFacts, 1);
  assert.ok(usage.summariesBytes > 0); assert.equal(usage.skippedSummaries, 0); // the first fact left room for the summary
  assert.ok(usage.factsBytes > 0);
});

test('停用事实与失效摘要不计入，重要摘要先于普通摘要', () => {
  const value = { schemaVersion: 1 as const, projectId: 'p', budgetBytes: 6000,
    facts: [fact('f1', '停用的事实', { enabled: false })],
    entries: [entry('old', '普通摘要'), entry('key', '重要摘要', { important: true }), entry('stale', '失效摘要')] };
  const usage = memoryUsage(value, ['stale']);
  assert.equal(usage.includedFacts, 0); assert.equal(usage.factsBytes, 0);
  assert.equal(usage.includedSummaries, 2); assert.equal(usage.skippedSummaries, 0);
  assert.ok(usage.summariesBytes > Buffer.byteLength('普通摘要'));
});

test('空记忆返回零占用并保留预算值', () => {
  const usage = memoryUsage({ schemaVersion: 1, projectId: 'p', budgetBytes: 6000, entries: [], facts: [] }, []);
  assert.deepEqual(usage, { budget: 6000, factsBytes: 0, summariesBytes: 0, includedFacts: 0, skippedFacts: 0, includedSummaries: 0, skippedSummaries: 0 });
});
