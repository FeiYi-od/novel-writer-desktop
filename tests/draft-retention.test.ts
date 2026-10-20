import test from 'node:test';
import assert from 'node:assert/strict';
import { describePrune, selectDraftsToPrune } from '../src/core/draft-retention';

const day = 24 * 60 * 60 * 1000;
const at = (daysAgo: number) => new Date(Date.parse('2026-10-19T00:00:00Z') - daysAgo * day).toISOString();
const make = (ages: number[]) => ages.map((age, index) => ({ id: `draft-${index}`, at: at(age) }));

test('备份保留策略：最新 N 份一律保留，只有更旧且超过天数才清理', () => {
  const now = new Date('2026-10-19T00:00:00Z');
  const drafts = make([0, 1, 2, 40, 50, 60]);
  const prune = selectDraftsToPrune(drafts, { keep: 3, olderThanDays: 30, now });
  assert.deepEqual(prune.map(item => item.id), ['draft-3', 'draft-4', 'draft-5'], '只清理最旧且超期的');
  const newestKept = selectDraftsToPrune(drafts, { keep: 100, olderThanDays: 1, now });
  assert.deepEqual(newestKept, [], '未超过保留份数时一份都不删');
});

test('备份保留策略：时间无法解析的旧副本按可清理处理，但绝不越过保留份数', () => {
  const now = new Date('2026-10-19T00:00:00Z');
  const drafts = [{ id: 'bad', at: 'not-a-date' }, ...make([0, 1])];
  const prune = selectDraftsToPrune(drafts, { keep: 2, olderThanDays: 30, now });
  assert.deepEqual(prune.map(item => item.id), ['bad']);
  assert.equal(selectDraftsToPrune(drafts, { keep: 3, olderThanDays: 30, now }).length, 0);
});

test('备份清理文案：说清当前份数、将清理多少、保留多少', () => {
  assert.match(describePrune(5, 0, 20), /都在保留范围内/u);
  assert.match(describePrune(25, 5, 20), /将清理 5 份较旧的，保留最新 20 份/u);
});
