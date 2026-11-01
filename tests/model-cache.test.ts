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
  assert.equal(ModelCache.key('generic', 'https://a/v1'), 'anonymous-v2|generic|https://a/v1');
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
  const request = { expectedHash: 'h', baseUrl: 'http://127.0.0.1:1/v1' } as unknown as ModelDiscoveryRequest;
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

test('模型发现：不同账号及匿名请求不共享模型列表，也不持久化已认证结果', async () => {
  const f = await fixture();
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_url, options) => {
    calls++;
    const auth = (options?.headers as Record<string, string>)?.Authorization;
    const id = auth === 'Bearer fake-A' ? 'account-A' : auth === 'Bearer fake-B' ? 'account-B' : 'anonymous';
    return new Response(JSON.stringify({ data: [{ id }] }), { status: 200 });
  }) as typeof fetch;
  const connections = { read: async () => ({ hash: 'h' }) } as unknown as AIConnections;
  const service = new ModelDiscoveryService(connections, 5000, new ModelCache(f.file));
  const request = { expectedHash: 'h', baseUrl: 'http://127.0.0.1:1/v1' };
  try {
    assert.equal((await service.discover({ ...request, apiKey: 'fake-A' })).models[0].id, 'account-A');
    assert.equal((await service.discover({ ...request, apiKey: 'fake-B' })).models[0].id, 'account-B');
    assert.equal((await service.discover(request)).models[0].id, 'anonymous');
    assert.equal((await service.discover(request)).cached, true);
    assert.equal(calls, 3);
    const disk = await fs.readFile(f.file, 'utf8');
    assert.ok(!disk.includes('fake-A') && !disk.includes('fake-B'));
    assert.ok(!disk.includes('account-A') && !disk.includes('account-B'));
  } finally { globalThis.fetch = previous; await fs.rm(f.root, { recursive: true, force: true }); }
});

test('模型发现：匿名缓存不读取旧版可能来自认证账号的数据', async () => {
  const f = await fixture();
  const previous = globalThis.fetch;
  const url = 'http://127.0.0.1:1/v1';
  await fs.writeFile(f.file, JSON.stringify({ [`generic|${url}`]: { checkedAt: new Date().toISOString(), models: [{ id: 'legacy-private' }] } }));
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ data: [{ id: 'public' }] })); }) as typeof fetch;
  const connections = { read: async () => ({ hash: 'h' }) } as unknown as AIConnections;
  const service = new ModelDiscoveryService(connections, 5000, new ModelCache(f.file));
  try {
    assert.equal((await service.discover({ expectedHash: 'h', baseUrl: url })).models[0].id, 'public');
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; await fs.rm(f.root, { recursive: true, force: true }); }
});

test('模型发现：缓存读取期间配置改变时丢弃结果', async () => {
  let hash = 'old';
  const connections = { read: async () => ({ hash }) } as unknown as AIConnections;
  const cache = { get: async () => { hash = 'new'; return { checkedAt: new Date().toISOString(), models: [{ id: 'stale' }] }; } } as unknown as ModelCache;
  const service = new ModelDiscoveryService(connections, 5000, cache);
  await assert.rejects(service.discover({ expectedHash: 'old', baseUrl: 'http://127.0.0.1:1/v1' }), /请求期间模型配置已更新/);
});

test('模型发现：写入匿名缓存期间配置改变时丢弃结果', async () => {
  let hash = 'old';
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ id: 'm' }] }))) as typeof fetch;
  const connections = { read: async () => ({ hash }) } as unknown as AIConnections;
  const cache = { get: async () => null, set: async () => { hash = 'new'; } } as unknown as ModelCache;
  try {
    await assert.rejects(new ModelDiscoveryService(connections, 5000, cache).discover({ expectedHash: 'old', baseUrl: 'http://127.0.0.1:1/v1' }), /请求期间模型配置已更新/);
  } finally { globalThis.fetch = previous; }
});
