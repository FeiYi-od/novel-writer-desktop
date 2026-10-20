import test from 'node:test';
import assert from 'node:assert/strict';
import { isStorageHost, parseStorageTargets, STORAGE_PROVIDERS } from '../src/core/storage-targets';

test('存储连接目标默认空；域名、IPv4 与 IPv6 明确使用所填端口', () => {
  assert.deepEqual(parseStorageTargets(' \n\r\n'), []);
  assert.deepEqual(parseStorageTargets('nas.example.test\n127.0.0.1:445\n[2001:db8::1]:8443\n::1\n[::1]'), [
    { host: 'nas.example.test', port: 443, label: 'nas.example.test' },
    { host: '127.0.0.1', port: 445, label: '127.0.0.1:445' },
    { host: '2001:db8::1', port: 8443, label: '[2001:db8::1]:8443' },
    { host: '::1', port: 443, label: '::1' },
    { host: '::1', port: 443, label: '[::1]' },
  ]);
  assert.equal(parseStorageTargets('2001:db8::443')[0]!.host, '2001:db8::443');
});

test('非法目标或端口不被静默跳过；错误注明实际行号', () => {
  for (const input of ['host:0', 'host:65536', 'host:-1', 'host:1.5', 'host:', 'https://host:443', 'user@host', 'host/path', 'host :443', '[::1]:', '[host]:443', '[::1]:abc', '256.0.0.1', '01.2.3.4', 'a..b', '-host', 'fe80::1%eth0']) {
    assert.throws(() => parseStorageTargets(`nas.example.test\n\n${input}`), /第 3 行/u, input);
  }
  assert.throws(() => parseStorageTargets(Array.from({ length: 9 }, () => 'localhost:443').join('\n')), /第 9 行.*最多/u);
  assert.throws(() => parseStorageTargets('x'.repeat(4001)), /4000/u);
});

test('存储主机检查拒绝 IPv4 缩写及注入，不把 URL/path 当作主机', () => {
  for (const good of ['localhost', 'nas.example.test', '127.0.0.1', '2001:db8::1', '::ffff:192.0.2.1']) assert.equal(isStorageHost(good), true, good);
  for (const bad of ['', '127.1', '2130706433', 'host:443', '[::1]', '::x', 'x#y', 'x?y', 'x\\y', 'x\ny', 'foo_bar', 'x.'.repeat(130)]) assert.equal(isStorageHost(bad), false, bad);
});

test('设备选择提供独立说明，无个人地址或账号预设', () => {
  const providers = new Map(STORAGE_PROVIDERS.map(item => [item.id, item]));
  for (const id of ['generic', 'fnos', 'synology', 'qnap', 'baidu', 'xunlei', 'onedrive', 'other'] as const) assert.ok(providers.get(id));
  assert.match(providers.get('baidu')!.guide, /不等于双向同步/u);
  assert.match(providers.get('xunlei')!.guide, /没有内置.*登录/u);
  assert.doesNotMatch(JSON.stringify(STORAGE_PROVIDERS), /(?:\d{1,3}\.){3}\d{1,3}|sk-[a-z0-9]+|\\\\[a-z]/iu);
});
