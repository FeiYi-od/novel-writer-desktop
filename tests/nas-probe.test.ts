import test from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { classifyPath, describeSyncState, needsAttention } from '../src/core/sync-status';
import { probeHost, probeTargets } from '../src/main/nas-probe';

test('同步位置：UNC 才确定是网络路径，映射盘不装作本地', () => {
  assert.equal(classifyPath('\\\\192.0.2.1\\小说'), 'unc');
  assert.equal(classifyPath('\\\\nas\\share\\book'), 'unc');
  assert.equal(classifyPath('D:\\小说\\甲'), 'unknown');
  assert.equal(classifyPath('/home/user/novel'), 'local');
  assert.equal(classifyPath('   '), 'unknown');
  assert.equal(classifyPath('relative\\path'), 'unknown');
});

test('同步状态：区分本地保存、网络目录未同步、失败与无法确认，且不会自称已同步 NAS', () => {
  assert.deepEqual(describeSyncState({ location: 'local', saved: true }), { level: 'local', text: '已保存到本机文件夹' });
  const unc = describeSyncState({ location: 'unc', saved: true });
  assert.equal(unc.level, 'unsynced');
  assert.match(unc.text, /无法确认|由飞牛客户端决定/u);
  assert.doesNotMatch(unc.text, /已同步/u);
  const failed = describeSyncState({ location: 'unc', saved: false, error: '磁盘不可写' });
  assert.deepEqual(failed, { level: 'failed', text: '保存失败：磁盘不可写' });
  const unknown = describeSyncState({ location: 'unknown', saved: true });
  assert.equal(unknown.level, 'unknown');
  assert.equal(needsAttention(unknown), true);
  assert.equal(needsAttention(describeSyncState({ location: 'local', saved: true })), false);
});

test('NAS 探测：开放的端口可达，关闭的端口报错，非法地址被拒绝', async () => {
  const server = net.createServer(socket => socket.end());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  const open = await probeHost({ host: '127.0.0.1', port, label: '本机测试' }, 2000);
  assert.equal(open.ok, true);
  assert.ok(open.ms >= 0);
  server.close();
  const closed = await probeHost({ host: '127.0.0.1', port }, 1500);
  assert.equal(closed.ok, false);
  const bad = await probeHost({ host: 'not a host', port }, 500);
  assert.equal(bad.ok, false);
  assert.match(bad.reason ?? '', /不合法/u);
  const batch = await probeTargets([{ host: '127.0.0.1', port: 1 }, { host: '127.0.0.1', port: 2 }], 800);
  assert.equal(batch.length, 2);
  assert.ok(batch.every(item => item.ok === false));
});

test('NAS IPv6 探测使用本机回环临时端口，拒绝网址与越界 IPv4', async () => {
  const server = net.createServer(socket => socket.end());
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '::1', resolve); });
    const port = (server.address() as net.AddressInfo).port;
    assert.equal((await probeHost({ host: '::1', port }, 1500)).ok, true);
    for (const host of ['https://localhost', '256.0.0.1', '[::1]', 'host/path']) {
      const result = await probeHost({ host, port }, 100);
      assert.equal(result.ok, false); assert.equal(result.ms, 0); assert.match(result.reason!, /不合法/u);
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
