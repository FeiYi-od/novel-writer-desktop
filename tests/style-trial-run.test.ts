import test from 'node:test';
import assert from 'node:assert/strict';
import { createRawCompletion, createStyleTrial } from '../src/main/style-trial-run';
import type { AIConnection } from '../src/shared/contracts';

const profile = { id: 'conn', name: '模型', baseUrl: 'http://127.0.0.1:1/v1', model: 'mock', adapter: 'generic' } as unknown as AIConnection;
const source = {
  read: async () => ({ hash: 'h'.repeat(8) }),
  resolve: async (id: string, expectedHash: string) => { assert.equal(id, 'conn'); assert.equal(expectedHash, 'h'.repeat(8)); return { profile, key: 'test-key' }; }
};

test('试写补全：复用既有 provider 通道，按连接解析密钥且不把密钥暴露给调用方', async () => {
  const calls: { model: string; messages: number; key: string }[] = [];
  const complete = createRawCompletion(source, async (given, key, messages, signal, onText) => {
    assert.equal(signal.aborted, false);
    calls.push({ model: given.model, messages: messages.length, key });
    onText('正文');
    return 'stop';
  });
  assert.equal(await complete('conn', [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], new AbortController().signal), '正文');
  assert.deepEqual(calls, [{ model: 'mock', messages: 2, key: 'test-key' }]);
});

test('试写补全：取消后不再发起请求', async () => {
  let called = 0;
  const complete = createRawCompletion(source, async () => { called += 1; return 'x'; });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(complete('conn', [{ role: 'user', content: 'u' }], controller.signal));
  assert.equal(called, 0);
});

test('试写服务：两个文风各写一版并给出客观比较', async () => {
  const trial = createStyleTrial(source, styleId => `规则-${styleId}`, async (_profile, _key, messages, _signal, onText) => {
    const isSystem = messages[0].content.includes('规则-');
    assert.ok(isSystem, 'system 消息应包含该文风的规则');
    onText(messages[0].content.includes('规则-a') ? '雨落在北门上，很轻。她走了。' : '雨丝如织，金光泼洒，众人惊叹。');
    return 'stop';
  });
  const result = await trial.run('conn', { brief: '林夏抵达北门', styles: [{ styleId: 'a', styleName: '冷峻' }, { styleId: 'b', styleName: '华丽' }] });
  assert.equal(result.failures, 0);
  assert.deepEqual(result.variants.map(item => item.styleId), ['a', 'b']);
  assert.equal(result.comparison.rows.length, 2);
  assert.equal(result.comparison.mostSimilar?.[0], 'a');
});

test('试写补全：streamChat 只返回完成原因，正文必须从回调累积', async () => {
  const complete = createRawCompletion(source, async (_profile, _key, _messages, _signal, onText) => {
    onText('雨落在');
    onText('北门上。');
    return 'stop';
  });
  assert.equal(await complete('conn', [{ role: 'user', content: 'u' }], new AbortController().signal), '雨落在北门上。');
});