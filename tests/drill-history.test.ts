import test from 'node:test';
import assert from 'node:assert/strict';
import { appendHistory, summarizeHistory, type DrillRecord } from '../src/core/drill-history';

const record = (at: string, ok = true): DrillRecord => ({ at, ok, steps: [{ name: 'a', ok: true, detail: '' }, { name: 'b', ok, detail: '' }] });

test('自检历史：新记录排最前、相同时间戳去重、超过上限截断', () => {
  const history = appendHistory([record('2026-10-19T01:00:00Z')], record('2026-10-19T02:00:00Z'));
  assert.deepEqual(history.map(item => item.at), ['2026-10-19T02:00:00Z', '2026-10-19T01:00:00Z']);
  const deduped = appendHistory(history, record('2026-10-19T02:00:00Z', false));
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0]!.ok, false, '同一时间戳以最新结果为准');
  const many = Array.from({ length: 30 }, (_, index) => record(`2026-10-19T0${String(index % 10)}:${String(index).padStart(2, '0')}:00Z`));
  assert.equal(appendHistory([], record('2026-10-19T03:00:00Z'), 5).length, 1);
  assert.equal(many.reduce<DrillRecord[]>((acc, item) => appendHistory(acc, item, 5), []).length, 5);
});

test('自检历史摘要：给出通过数与总数，便于面板显示', () => {
  const summary = summarizeHistory([record('2026-10-19T02:00:00Z'), record('2026-10-19T01:00:00Z', false)], 1);
  assert.equal(summary.length, 1);
  assert.deepEqual(summary[0], { at: '2026-10-19T02:00:00Z', ok: true, passed: 2, total: 2 });
});
