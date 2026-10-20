import test from 'node:test';
import assert from 'node:assert/strict';
import { chatBody, setUsageSink, streamChat } from '../src/main/ai-provider';
import type { AIConnection } from '../src/shared/contracts';
import type { AIConnections } from '../src/main/ai-connections';

const profile = { id: 'oll', name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:7b', adapter: 'ollama', maxOutputTokens: 256, tokenParameter: 'max_tokens', thinking: 'default' } as unknown as AIConnection;

async function withFetch(body: string, contentType: string, run: (seen: { url: string; init: RequestInit }) => Promise<void>) {
  const original = globalThis.fetch;
  const seen = { url: '', init: {} as RequestInit };
  globalThis.fetch = (async (url: unknown, init: RequestInit) => { seen.url = String(url); seen.init = init; return new Response(body, { status: 200, headers: { 'content-type': contentType } }); }) as typeof fetch;
  try { await run(seen); } finally { globalThis.fetch = original; }
}

test('Ollama 原生协议：请求体与端点正确，NDJSON 增量拼接并上报用量', async () => {
  const body = chatBody(profile, [{ role: 'system', content: '你是编辑' }, { role: 'user', content: '写一段' }]) as Record<string, unknown>;
  assert.equal(body.stream, true);
  assert.deepEqual(body.options, { num_predict: 256 }, '输出上限走 options.num_predict');
  assert.equal(body.max_tokens, undefined, '不应出现 OpenAI 的 max_tokens');
  const ndjson = [
    JSON.stringify({ message: { role: 'assistant', content: '雨落在' }, done: false }),
    JSON.stringify({ message: { role: 'assistant', content: '北门上。' }, done: false }),
    JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 34 })
  ].join('\n') + '\n';
  const used: string[] = [];
  setUsageSink(sample => { used.push(`${sample.prompt}/${sample.completion}`); });
  try {
    await withFetch(ndjson, 'application/x-ndjson', async seen => {
      let text = '';
      const finish = await streamChat(profile, '', [{ role: 'user', content: 'hi' }], new AbortController().signal, chunk => { text += chunk; });
      assert.equal(seen.url, 'http://127.0.0.1:11434/api/chat');
      assert.equal(text, '雨落在北门上。');
      assert.equal(finish, 'stop');
      assert.deepEqual(used, ['12/34'], '用量应上报给统一 sink');
    });
  } finally { setUsageSink(null); }
});

test('Ollama 原生协议：done_reason=length 记截断，错误行抛错，非 NDJSON 响应被拒绝', async () => {
  await withFetch(JSON.stringify({ message: { content: '半句' }, done: true, done_reason: 'length' }) + '\n', 'application/x-ndjson', async () => {
    let text = '';
    const finish = await streamChat(profile, '', [{ role: 'user', content: 'x' }], new AbortController().signal, chunk => { text += chunk; });
    assert.equal(text, '半句');
    assert.equal(finish, 'length');
  });
  await withFetch(JSON.stringify({ error: 'model not found' }) + '\n', 'application/x-ndjson', async () => {
    await assert.rejects(streamChat(profile, '', [{ role: 'user', content: 'x' }], new AbortController().signal, () => {}), /model not found/u);
  });
  await withFetch('data: {"x":1}\n\n', 'text/event-stream', async () => {
    await assert.rejects(streamChat(profile, '', [{ role: 'user', content: 'x' }], new AbortController().signal, () => {}), /NDJSON/u);
  });
});

test('Ollama 原生协议：模型目录走 /api/tags', async () => {
  const { ModelDiscoveryService } = await import('../src/main/model-discovery');
  const connections = { read: async () => ({ hash: 'h' }), resolve: async () => { throw new Error('unused'); } } as unknown as AIConnections;
  const service = new ModelDiscoveryService(connections);
  await withFetch(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }, { name: 'llama3.1:8b' }] }), 'application/json', async seen => {
    const list = await service.discover({ expectedHash: 'h', baseUrl: 'http://127.0.0.1:11434', adapter: 'ollama' } as never);
    assert.equal(seen.url, 'http://127.0.0.1:11434/api/tags');
    assert.deepEqual(list.models.map(model => model.id), ['qwen2.5:7b', 'llama3.1:8b']);
  });
});