import test from 'node:test';
import assert from 'node:assert/strict';
import { StyleTrialService } from '../src/main/style-trial';

const styles = [
  { styleId: 'a', styleName: '冷峻' },
  { styleId: 'b', styleName: '华丽' },
  { styleId: 'c', styleName: '口语' }
];

test('文风试写：按顺序逐版调用，失败的一版单独记录不中断', async () => {
  const calls: string[] = [];
  const service = new StyleTrialService(async style => {
    calls.push(style.styleId);
    if (style.styleId === 'b') throw new Error('模型超时');
    return style.styleId === 'a' ? '雨落在北门上，很轻。她走了。' : '雨丝如织，金光泼洒，众人惊叹。';
  });
  const result = await service.run({ brief: '林夏抵达北门', styles });
  assert.deepEqual(calls, ['a', 'b', 'c'], '必须顺序执行，不能并发');
  assert.equal(result.failures, 1);
  assert.equal(result.variants.find(item => item.styleId === 'b')?.error, '模型超时');
  assert.deepEqual(result.comparison.rows.map(row => row.styleId), ['a', 'c'], '比较只针对成功的版本');
  assert.equal(result.comparison.mostSimilar?.[0], 'a');
});

test('文风试写：参数校验与重复文风被拒绝', async () => {
  const service = new StyleTrialService(async () => '正文');
  await assert.rejects(service.run({ brief: '  ', styles }), /剧情要求/u);
  await assert.rejects(service.run({ brief: 'x', styles: [] }), /至少选择一个文风/u);
  await assert.rejects(service.run({ brief: 'x', styles: [...styles, { styleId: 'a', styleName: '重复' }] }), /不能重复/u);
  await assert.rejects(service.run({ brief: 'x'.repeat(4001), styles }), /过长/u);
});

test('文风试写：进行中拒绝再次启动，停止后不再继续调用', async () => {
  let started = 0;
  const gate: { release?: () => void } = {};
  const service = new StyleTrialService(async () => {
    started += 1;
    if (started === 1) await new Promise<void>(resolve => { gate.release = resolve; });
    return '正文内容';
  });
  const running = service.run({ brief: 'x', styles });
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(service.run({ brief: 'y', styles }), /已有试写比较/u);
  service.cancel();
  gate.release?.();
  await assert.rejects(running, /abort|Abort/u);
  assert.equal(started, 1, '停止后不应继续写下一版');
});
