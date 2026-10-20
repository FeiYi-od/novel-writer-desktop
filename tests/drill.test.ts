import test from 'node:test';
import assert from 'node:assert/strict';
import { runOfflineDrill } from '../src/main/drill';

test('断网演练自检：三个场景全部通过，且只在临时目录里操作', async () => {
  const report = await runOfflineDrill();
  assert.equal(report.steps.length, 3);
  assert.deepEqual(report.steps.map(step => step.name), ['外部改动时拒绝覆盖', '网络目录不可用时保住草稿', '恢复后继续写作']);
  for (const step of report.steps) assert.ok(step.ok, `${step.name} 未通过：${step.detail}`);
  assert.equal(report.ok, true);
  assert.match(report.at, /^\d{4}-\d{2}-\d{2}T/u);
});
