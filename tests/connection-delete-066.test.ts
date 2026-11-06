import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AIConnections } from '../src/main/ai-connections';
import type { AIConnectionEdit } from '../src/shared/contracts';

const codec = { encrypt: (value: string) => Buffer.from('enc:' + value, 'utf8'), decrypt: (buffer: Buffer) => buffer.toString('utf8').replace(/^enc:/u, '') };
const base: Omit<AIConnectionEdit, 'name' | 'apiKey'> = {
  adapter: 'generic', thinking: 'default', timeoutSeconds: 300,
  baseUrl: 'https://api.example.com/v1', model: 'model-a', contextWindow: 8192, maxOutputTokens: 1024, tokenParameter: 'max_tokens'
};

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-conn-'));
  const store = new AIConnections(root, codec);
  const first = await store.save({ ...base, name: '甲连接', apiKey: 'sk-a' }, '');
  const second = await store.save({ ...base, name: '乙连接', model: 'model-b' }, first.hash);
  return { root, store, first, second };
}

test('删除模型连接：只删目标，另一个保留，密钥不被复活', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const target = f.second.connections.find(item => item.name === '甲连接')!;
  const after = await f.store.remove(target.id, f.second.hash);
  assert.deepEqual(after.connections.map(item => item.name), ['乙连接']);
  assert.equal(after.connections[0]!.hasKey, false);
  const raw = JSON.parse(await fs.readFile(path.join(f.root, 'ai-connections.json'), 'utf8'));
  assert.equal(raw.connections.length, 1);
  assert.equal(raw.connections[0].name, '乙连接');
});

test('删除模型连接：旧哈希、重复删除、未知 id、非法 id 全部拒绝', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const target = f.second.connections[0]!;
  await assert.rejects(f.store.remove(target.id, 'stale'), /已更新/u);
  await assert.rejects(f.store.remove(crypto.randomUUID(), f.second.hash), /不存在|已删除/u);
  await assert.rejects(f.store.remove('not-a-uuid', f.second.hash), /uuid|invalid|Invalid/u as unknown as RegExp);
  const after = await f.store.remove(target.id, f.second.hash);
  const left = after.connections[0]!;
  await assert.rejects(f.store.remove(target.id, after.hash), /不存在|已删除/u);
  assert.equal((await f.store.read()).connections.length, 1);
  assert.equal((await f.store.read()).connections[0]!.id, left.id);
});

test('删除模型连接：可解密的密钥随连接一起消失，备份文件保留旧版本', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const keyed = f.second.connections.find(item => item.hasKey)!;
  assert.equal(keyed.keyState, 'ok');
  const after = await f.store.remove(keyed.id, f.second.hash);
  assert.equal(after.connections.some(item => item.id === keyed.id), false);
  const backups = await fs.readdir(f.root);
  assert.ok(backups.some(name => name.includes('previous') || name.includes('ai-connections')), '应保留上一版本备份');
});
