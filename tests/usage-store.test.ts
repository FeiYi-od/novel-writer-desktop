import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UsageStore } from '../src/main/usage-store';
import { setUsageSink, streamChat } from '../src/main/ai-provider';
import type { AIConnection } from '../src/shared/contracts';

const profile = { id: 'c1', name: '主模型', baseUrl: 'http://127.0.0.1:1/v1', model: 'mock', adapter: 'generic' } as unknown as AIConnection;

async function withFetch(body: string, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = original; }
}

test('用量统计：一次调用同时记录到 sink 与本地文件', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-usage-'));
  const store = new UsageStore(path.join(root, 'ai-usage.json'));
  const seen: string[] = [];
  setUsageSink(sample => { seen.push(`${sample.connectionId}:${sample.prompt}/${sample.completion}`); void store.record(sample); });
  try {
    await withFetch('data: {"choices":[{"index":0,"delta":{"content":"正文"},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":22}}\n\ndata: [DONE]\n\n', async () => {
      const text = await streamChat(profile, 'k', [{ role: 'user', content: 'hi' }], new AbortController().signal, () => {});
      assert.equal(text, 'stop');
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(seen, ['c1:11/22']);
    const entries = await store.read();
    assert.equal(entries.length, 1);
    assert.deepEqual([entries[0].prompt, entries[0].completion, entries[0].calls, entries[0].model], [11, 22, 1, 'mock']);
    await store.record({ connectionId: 'c1', connectionName: '主模型', model: 'mock', prompt: 1, completion: 2 });
    const again = await store.read();
    assert.deepEqual([again[0].prompt, again[0].calls], [12, 2], '同连接同模型应合并');
  } finally {
    setUsageSink(null);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('用量统计：响应里没有 usage 时不写记录', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-usage2-'));
  const store = new UsageStore(path.join(root, 'ai-usage.json'));
  const seen: string[] = [];
  setUsageSink(sample => { seen.push(sample.connectionId); void store.record(sample); });
  try {
    await withFetch('data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', async () => {
      await streamChat(profile, 'k', [{ role: 'user', content: 'hi' }], new AbortController().signal, () => {});
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(seen, []);
    assert.deepEqual(await store.read(), []);
  } finally {
    setUsageSink(null);
    await fs.rm(root, { recursive: true, force: true });
  }
});
