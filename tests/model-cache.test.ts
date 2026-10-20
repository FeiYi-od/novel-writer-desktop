import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelCache, MODEL_CACHE_TTL_MS } from '../src/main/model-cache';
import { ModelDiscoveryService } from '../src/main/model-discovery';
import type { AIConnections } from '../src/main/ai-connections';
import type { ModelDiscoveryRequest } from '../src/shared/contracts';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-mcache-'));
  return { root, file: path.join(root, 'model-cache.json') };
}
const list = [{ id: 'gpt-4o-mini' }, { id: 'deepseek-reasoner' }];

test('模型缓存：写入后可读，超 TTL 视为过期，键不含密钥', async () => {
  const f = await fixture();
  let clock = Date.parse('2026-10-18T00:00:00Z');
  const cache = new ModelCache(f.file, () => clock);
  assert.equal(await cache.get('generic', 'https://a/v1'), null);
  await cache.set('generic', 'https://a/v1', list);
  const hit = await cache.get('generic', 'https://a/v1');
  assert.deepEqual(hit?.models, list);
  clock += MODEL_CACHE_TTL_MS - 1000;
  assert.ok(await cache.get('generic', 'https://a/v1'), 'TTL 内仍有效');
  clock += 2000;
  assert.equal(await cache.get('generic', 'https://a/v1'), null, '超过 TTL 应失效');
  assert.equal(ModelCache.key('generic', 'https://a/v1'), 'generic|https://a/v1');
  await cache.clear();
  await fs.rm(f.root, { recursive: true, force: true });
});

test('模型发现：第二次走缓存，refresh 强制重新请求', async () => {
  const f = await fixture();
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { calls += 1; return new Response(JSON.stringify({ data: list }), { status: 200, headers: { 'content-type': 'application/json' } }); }) as typeof fetch;
  const connections = { read: async () => ({ hash: 'h' }), resolve: async () => { throw new Error('unused'); } } as unknown as AIConnections;
  const cache = new ModelCache(f.file);
  const service = new ModelDiscoveryService(connections, 5000, cache);
  const request = { expectedHash: 'h', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test-key-abcdef' } as unknown as ModelDiscoveryRequest;
  try {
    const first = await service.discover(request);
    assert.equal(first.cached, undefined, '首次不是缓存');
    const second = await service.discover(request);
    assert.equal(second.cached, true, '第二次应命中缓存');
    assert.equal(calls, 1, '命中缓存不应再发请求');
    await service.discover({ ...request, refresh: true } as ModelDiscoveryRequest);
    assert.equal(calls, 2, 'refresh 必须重新请求');
  } finally { globalThis.fetch = original; await fs.rm(f.root, { recursive: true, force: true }); }
});
