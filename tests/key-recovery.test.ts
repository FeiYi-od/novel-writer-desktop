import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describeKeyState, inspectKeys, keepPreviousCopy, restoreFromBackup } from '../src/main/key-recovery';
import type { SecretCodec } from '../src/main/ai-connections';

/** Codes that can be "rotated" to imitate an OS keyring reset after a force-quit. */
function codec(prefix = 'v1'): SecretCodec & { rotate: (next: string) => void } {
  let current = prefix;
  return {
    encrypt: value => Buffer.from(`${current}:${value}`, 'utf8'),
    decrypt: value => {
      const text = value.toString('utf8');
      if (!text.startsWith(`${current}:`)) throw new Error('cannot decrypt');
      return text.slice(current.length + 1);
    },
    rotate: next => { current = next; }
  };
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-keys-'));
  return { root, file: path.join(root, 'ai-connections.json') };
}
const write = (file: string, connections: unknown[]) => fs.writeFile(file, JSON.stringify({ schemaVersion: 1, connections }, null, 2), 'utf8');
const item = (id: string, name: string, key: string, use: ReturnType<typeof codec>) => ({ id, name, encryptedKey: key ? use.encrypt(key).toString('base64') : '' });

test('密钥状态：区分可用、未填写、系统凭据变化后无法解密', async () => {
  const f = await fixture();
  const keys = codec();
  await write(f.file, [item('11111111-1111-4111-8111-111111111111', '主模型', 'sk-test', keys), item('22222222-2222-4222-8222-222222222222', '无密钥', '', keys)]);
  const before = await inspectKeys(f.file, keys);
  assert.deepEqual(before.connections.map(entry => entry.state), ['ok', 'missing']);
  keys.rotate('v2'); // 模拟强制退出后系统凭据重置
  const after = await inspectKeys(f.file, keys);
  assert.deepEqual(after.connections.map(entry => entry.state), ['unreadable', 'missing']);
  assert.match(describeKeyState('unreadable'), /重新填写/u);
  await fs.rm(f.root, { recursive: true, force: true });
});

test('密钥状态：主文件损坏时报告改用备份，且备份存在性可查', async () => {
  const f = await fixture();
  const keys = codec();
  await write(f.file, [item('11111111-1111-4111-8111-111111111111', '主模型', 'sk-test', keys)]);
  await keepPreviousCopy(f.file);
  await fs.writeFile(f.file, '{ 损坏的 json', 'utf8');
  const report = await inspectKeys(f.file, keys);
  assert.equal(report.backupUsable, true);
  assert.deepEqual(report.connections.map(entry => entry.state), ['ok'], '备份里的密钥仍可解密');
  await fs.rm(f.root, { recursive: true, force: true });
});

test('密钥恢复：可从备份恢复主文件；没有备份时明确报错', async () => {
  const f = await fixture();
  const keys = codec();
  await write(f.file, [item('11111111-1111-4111-8111-111111111111', '主模型', 'sk-test', keys)]);
  await keepPreviousCopy(f.file);
  const backup = await fs.readFile(`${f.file}.backup`, 'utf8');
  await fs.writeFile(f.file, '{}', 'utf8');
  assert.equal(await restoreFromBackup(f.file), true);
  assert.equal(await fs.readFile(f.file, 'utf8'), backup);
  await fs.rm(`${f.file}.backup`);
  await assert.rejects(restoreFromBackup(f.file), /没有可用的连接备份文件/u);
  await fs.rm(f.root, { recursive: true, force: true });
});
