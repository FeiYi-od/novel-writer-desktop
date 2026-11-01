import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inspectSillyPlugin, SILLY_PLUGIN_INSPECT_LIMITS as LIMITS } from '../src/main/silly-plugin-inspect';

async function fixture() {
  const root = await fs.mkdtemp(path.resolve('.artifacts/plugin-inspect-055-'));
  const plugin = path.join(root, '虚构插件'); await fs.mkdir(plugin);
  const manifest = { display_name: '虚构世界助手', version: '1.2.3', js: 'src/index.js', css: 'style.css', hooks: { activate: 'init', clean: 'clean' }, requires: ['mock-api'], optional: [] };
  await fs.mkdir(path.join(plugin, 'src'));
  await fs.writeFile(path.join(plugin, 'src', 'index.js'), 'throw new Error("should never execute");');
  await fs.writeFile(path.join(plugin, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(plugin, 'LICENSE'), '虚构许可，仅用于测试');
  return { root, plugin, manifest, id: randomUUID() };
}
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

test('只读分析：清单、入口、依赖、许可和文件哈希，绑定小说且不执行脚本', async () => {
  const f = await fixture(), result = await inspectSillyPlugin(f.id, f.plugin);
  assert.equal(result.schemaVersion, 1); assert.equal(result.projectId, f.id); assert.equal(result.executed, false);
  assert.equal(result.displayName, '虚构世界助手'); assert.equal(result.version, '1.2.3');
  assert.deepEqual(result.js, { path: 'src/index.js', exists: true });
  assert.deepEqual(result.css, { path: 'style.css', exists: false });
  assert.deepEqual(result.hooks, { activate: 'init', clean: 'clean', other: [] });
  assert.deepEqual(result.requires, ['mock-api']); assert.equal(result.license.present, true);
  assert.deepEqual(result.license.files, ['LICENSE']);
  const source = result.files.find(file => file.path === 'src/index.js');
  assert.equal(source?.sha256, digest('throw new Error("should never execute");'));
  assert.ok(result.warnings.some(value => value.includes('未执行')));
  assert.ok(!JSON.stringify(result).includes(f.root), '报告不能含用户绝对目录');
  assert.ok(!JSON.stringify(result).includes('should never execute'), '报告不能含插件源代码');
  const again = await inspectSillyPlugin(f.id, f.plugin);
  assert.equal(again.fingerprint, result.fingerprint);
  const other = await inspectSillyPlugin(randomUUID(), f.plugin);
  assert.notEqual(other.fingerprint, result.fingerprint, '指纹绑定小说 ID');
});

test('缺失入口和许可证只生成明确警告，不能宣称已运行或可兼容', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.plugin, 'manifest.json'), JSON.stringify({ display_name: '虚构', js: 'missing.js' }));
  await fs.unlink(path.join(f.plugin, 'LICENSE'));
  const report = await inspectSillyPlugin(f.id, f.plugin);
  assert.deepEqual(report.js, { path: 'missing.js', exists: false });
  assert.equal(report.license.present, false); assert.equal(report.executed, false);
  assert.ok(report.warnings.some(value => value.includes('入口不存在')));
  assert.ok(report.warnings.some(value => value.includes('许可证')));
});

test('清单越界、绝对路径、协议、控制字符和凭据形状的元信息均拒绝，不回显危险值', async () => {
  const f = await fixture(), file = path.join(f.plugin, 'manifest.json');
  const key = 'sk-' + 'a'.repeat(32);
  const bad = [
    { js: '../escape.js' }, { js: '/root.js' }, { js: 'C:\\escape.js' }, { js: 'https://invalid.example/a.js' },
    { js: 'a/%2e%2e/b.js' }, { js: 'src/CON.js' }, { css: 'src/../../outside.css' },
    { display_name: 'data:text/html,malicious' }, { display_name: `name\u0000bad` }, { display_name: key },
    { requires: [key] }, { hooks: { activate: key } }, { display_name: key.replace('-', '%2D') },
    { display_name: 'https%3A%2F%2Finvalid.example' }, { display_name: 'token=private-value' }, { version: 'a'.repeat(60) }
  ];
  for (const change of bad) {
    await fs.writeFile(file, JSON.stringify({ ...f.manifest, ...change }));
    await assert.rejects(inspectSillyPlugin(f.id, f.plugin), error => error instanceof Error && !error.message.includes(key));
  }
  await assert.rejects(inspectSillyPlugin('not-a-project', f.plugin), /小说标识/u);
  await assert.rejects(inspectSillyPlugin(f.id, 'relative/path'), /插件目录/u);
});

test('清单无效 UTF-8、过大、错误 hooks 或依赖均不能冒充正常报告', async () => {
  const f = await fixture(), file = path.join(f.plugin, 'manifest.json');
  for (const bad of [Buffer.from([0xff, 0xfe]), Buffer.alloc(LIMITS.manifestBytes + 1, 0x20), Buffer.from('[]'),
    Buffer.from(JSON.stringify({ display_name: '虚构', hooks: [] })), Buffer.from(JSON.stringify({ display_name: '虚构', requires: ['a', 3] }))]) {
    await fs.writeFile(file, bad); await assert.rejects(inspectSillyPlugin(f.id, f.plugin));
  }
});

test('缺失或损坏的清单先拒绝，不读取其他文件，系统错误不暴露目录', async t => {
  const f = await fixture(), file = path.join(f.plugin, 'manifest.json');
  const original = fs.open.bind(fs); const opened: string[] = [];
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => { opened.push(String(args[0])); return original(...args); });
  await fs.writeFile(file, '{损坏');
  await assert.rejects(inspectSillyPlugin(f.id, f.plugin));
  assert.deepEqual(opened, [file]);
  opened.length = 0;
  await fs.unlink(file);
  await assert.rejects(inspectSillyPlugin(f.id, f.plugin), error => error instanceof Error && !error.message.includes(f.plugin));
  assert.deepEqual(opened, []);
  await assert.rejects(inspectSillyPlugin(f.id, path.join(f.root, 'missing-private-path')), error => error instanceof Error && !error.message.includes(f.root));
});

test('嵌套目录链接或选中的根链接不能指向其他小说或系统文件', async () => {
  const f = await fixture(), outside = path.join(f.root, '另一虚构小说'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), '不应该读取');
  const nested = path.join(f.plugin, 'link'); await fs.symlink(outside, nested, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inspectSillyPlugin(f.id, f.plugin), /链接|越界/u);
  assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), '不应该读取');
  await fs.unlink(nested);
  const rootLink = path.join(f.root, '插件链接'); await fs.symlink(f.plugin, rootLink, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inspectSillyPlugin(f.id, rootLink), /链接|越界/u);
});

test('硬链接文件不能让插件目录引用其他小说的文件', async () => {
  const f = await fixture(), other = path.join(f.root, '其他虚构文件.txt');
  await fs.writeFile(other, '不能被当成插件内容');
  const linked = path.join(f.plugin, 'hardlink.txt');
  await fs.link(other, linked);
  await assert.rejects(inspectSillyPlugin(f.id, f.plugin), /链接/u);
  assert.equal(await fs.readFile(other, 'utf8'), '不能被当成插件内容');
});

test('文件符号链接不得被检查或跟随', async t => {
  const f = await fixture(), other = path.join(f.root, '其他虚构文件.txt');
  await fs.writeFile(other, '不可读取');
  try { await fs.symlink(other, path.join(f.plugin, 'linked.txt'), 'file'); }
  catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('系统无权限创建文件符号链接'); return; } throw error; }
  await assert.rejects(inspectSillyPlugin(f.id, f.plugin), /链接/u);
});

test('扫描全树并限制文件数量、单文件与总字节', async t => {
  await t.test('文件数量', async () => {
    const f = await fixture();
    for (let index = 0; index < LIMITS.files; index++) await fs.writeFile(path.join(f.plugin, `file-${index}.txt`), '');
    await assert.rejects(inspectSillyPlugin(f.id, f.plugin), /数量|总数/u);
  });
  await t.test('单文件大小', async () => {
    const f = await fixture(); await fs.writeFile(path.join(f.plugin, 'large.dat'), Buffer.alloc(LIMITS.fileBytes + 1));
    await assert.rejects(inspectSillyPlugin(f.id, f.plugin), /大小上限/u);
  });
  await t.test('总大小', async () => {
    const f = await fixture();
    for (let index = 0; index < 4; index++) await fs.writeFile(path.join(f.plugin, `large-${index}.dat`), Buffer.alloc(LIMITS.fileBytes));
    await assert.rejects(inspectSillyPlugin(f.id, f.plugin), /总大小/u);
  });
});

test('两次扫描之间源文件变化必须丢弃旧报告', async t => {
  const f = await fixture(), manifestFile = path.join(f.plugin, 'manifest.json');
  const original = fs.opendir.bind(fs); let rootReads = 0, injected = false;
  t.mock.method(fs, 'opendir', async (...args: Parameters<typeof fs.opendir>) => {
    if (typeof args[0] === 'string' && path.resolve(args[0]) === f.plugin && ++rootReads === 2) {
      injected = true; await fs.writeFile(manifestFile, JSON.stringify({ ...f.manifest, display_name: '外部修改' }));
    }
    return original(...args);
  });
  await assert.rejects(inspectSillyPlugin(f.id, f.plugin), /变化/u);
  assert.equal(injected, true);
});

test('第二次扫描读取文件后发生原位修改，最后核对仍须拒绝', async t => {
  const f = await fixture(), source = path.join(f.plugin, 'src', 'index.js');
  const original = fs.lstat.bind(fs); let rootReads = 0, injected = false;
  t.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
    if (typeof args[0] === 'string' && path.resolve(args[0]) === f.plugin && ++rootReads === 11) {
      injected = true; await fs.writeFile(source, '外部改变的虚构插件脚本');
    }
    return original(...args);
  });
  await assert.rejects(inspectSillyPlugin(f.id, f.plugin), /变化/u);
  assert.equal(injected, true);
});
