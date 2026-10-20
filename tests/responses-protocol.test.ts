import test from 'node:test';
import assert from 'node:assert/strict';
import { chatBody, streamChat } from '../src/main/ai-provider';
import type { AIConnection } from '../src/shared/contracts';

const profile = { id: 'c1', name: '响应协议', baseUrl: 'http://127.0.0.1:1/v1', model: 'gpt-5', adapter: 'responses', maxOutputTokens: 800, tokenParameter: 'max_output_tokens', thinking: 'default' } as unknown as AIConnection;

async function withFetch(body: string, run: (request: { url: string; init: RequestInit }) => Promise<void>, status = 200) {
  const original = globalThis.fetch;
  const seen = { url: '', init: {} as RequestInit };
  globalThis.fetch = (async (url: unknown, init: RequestInit) => { seen.url = String(url); seen.init = init; return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } }); }) as typeof fetch;
  try { await run(seen); } finally { globalThis.fetch = original; }
}

test('Responses 协议：请求体用 instructions + input，走 /responses', async () => {
  const body = chatBody(profile, [{ role: 'system', content: '你是编辑' }, { role: 'user', content: '写一段' }]) as Record<string, unknown>;
  assert.equal(body.instructions, '你是编辑');
  assert.deepEqual(body.input, [{ role: 'user', content: [{ type: 'input_text', text: '写一段' }] }]);
  assert.equal(body.max_output_tokens, 800);
  assert.equal(body.stream, true);
  assert.equal(body.messages, undefined, '不应出现 chat/completions 的 messages 字段');
  await withFetch('data: {"type":"response.completed","response":{"status":"completed"}}\n\ndata: [DONE]\n\n', async seen => {
    await streamChat(profile, 'k', [{ role: 'user', content: 'hi' }], new AbortController().signal, () => {});
    assert.equal(seen.url, 'http://127.0.0.1:1/v1/responses');
    assert.match(String((seen.init.headers as Record<string, string>).Authorization ?? ''), /Bearer k/u);
  });
});

test('Responses 协议：解析 output_text 增量并在 completed 时结束', async () => {
  const events = [
    'data: {"type":"response.created","response":{"status":"in_progress"}}\n\n',
    'data: {"type":"response.output_text.delta","delta":"雨落在"}\n\n',
    'data: {"type":"response.output_text.delta","delta":"北门上。"}\n\n',
    'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    'data: [DONE]\n\n'
  ].join('');
  await withFetch(events, async () => {
    let text = '';
    const finish = await streamChat(profile, 'k', [{ role: 'user', content: 'hi' }], new AbortController().signal, chunk => { text += chunk; });
    assert.equal(text, '雨落在北门上。');
    assert.equal(finish, 'stop');
  });
});

test('Responses 协议：incomplete 视为长度截断，失败事件抛错并保留原因', async () => {
  await withFetch('data: {"type":"response.completed","response":{"status":"incomplete"}}\n\ndata: [DONE]\n\n', async () => {
    const finish = await streamChat(profile, 'k', [{ role: 'user', content: 'hi' }], new AbortController().signal, () => {});
    assert.equal(finish, 'length');
  });
  await withFetch('data: {"type":"response.failed","response":{"error":{"message":"内容被拒绝"}}}\n\ndata: [DONE]\n\n', async () => {
    await assert.rejects(streamChat(profile, 'k', [{ role: 'user', content: 'hi' }], new AbortController().signal, () => {}), /内容被拒绝/u);
  });
});
