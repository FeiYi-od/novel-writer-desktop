import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { Workspace } from '../src/main/workspace';
import { backupBook, restoreBackup, verifyBackup, isSafeRelative } from '../src/main/nas-backup';
import { exportBookZip } from '../src/main/book-export';
import { textDocument } from '../src/main/text-import';

const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-backup-hardening-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials'));
  await workspace.initialize();
  const book = path.join(root, '虚构书'); await fs.mkdir(book);
  const project = await workspace.attach(book);
  await workspace.createChapter(project.id, textDocument('两位虚构角色在月港相遇。'));
  const notes = await workspace.readNotes(project.id);
  await workspace.saveNotes(project.id, { ...notes.value, world: '月港每天出现两次潮汐。' }, notes.hash);
  return { root, workspace, project };
}

test('备份不能用控制清单覆盖书内原有 manifest.json', async t => {
  const f = await fixture(t);
  const original = '{"original":"虚构作品自己的文件"}';
  await fs.writeFile(path.join(f.project.root, 'manifest.json'), original);
  const backup = await backupBook(f.workspace, f.project.id, path.join(f.root, '备份'));
  assert.equal((await verifyBackup(backup.folder)).ok, true, '成功备份必须可以完整校验');
  const restored = await restoreBackup(backup.folder, path.join(f.root, '恢复'));
  assert.equal(await fs.readFile(path.join(restored.folder, 'manifest.json'), 'utf8'), original);
  assert.equal(await fs.readFile(path.join(f.project.root, 'manifest.json'), 'utf8'), original);
});

test('整书 ZIP 不会因书根清单和资料同名而静默覆盖任何原件', async t => {
  const f = await fixture(t);
  const original = '{"original":"书内的清单"}';
  await fs.writeFile(path.join(f.project.root, 'manifest.json'), original);
  await fs.mkdir(path.join(f.project.root, '资料'));
  const packaged = '作者自己放在书目录里的参考资料';
  await fs.writeFile(path.join(f.project.root, '资料', '创作笔记.md'), packaged);
  const target = path.join(f.root, '整书.zip');
  const result = await exportBookZip(f.workspace, f.project.id, target);
  const zip = await JSZip.loadAsync(await fs.readFile(target));
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as { entries: { path: string; bytes: number; sha256: string }[] };
  assert.equal(manifest.entries.length, result.files);
  assert.equal(new Set(manifest.entries.map(item => item.path.toLowerCase())).size, result.files, '每份原件必须有独立条目');
  for (const item of manifest.entries) {
    const data = await zip.file(item.path)!.async('nodebuffer');
    assert.equal(data.length, item.bytes, `${item.path} 字节数必须对应实际内容`);
    assert.equal(digest(data), item.sha256, `${item.path} 内容不能被清单或资料覆盖`);
  }
  const strings = await Promise.all(Object.values(zip.files).filter(file => !file.dir).map(file => file.async('string')));
  assert.ok(strings.includes(original), '保留作品自己的清单');
  assert.ok(strings.includes(packaged), '保留书目录内资料');
  assert.ok(strings.some(value => value.includes('月港每天出现两次潮汐')), '保留本机正式世界观');
});

test('备份清单错误字节数不能通过校验', async t => {
  const f = await fixture(t);
  const backup = await backupBook(f.workspace, f.project.id, path.join(f.root, '备份'));
  const file = path.join(backup.folder, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  manifest.entries[0].bytes += 1; manifest.bytes += 1;
  await fs.writeFile(file, JSON.stringify(manifest));
  assert.equal((await verifyBackup(backup.folder)).ok, false, '哈希相同不能掩盖清单大小不符');
  await assert.rejects(restoreBackup(backup.folder, path.join(f.root, '恢复')), /校验失败/u);
});

test('备份清单指向目录链接时不能读取和恢复链接之外的数据', async t => {
  const f = await fixture(t);
  const backup = await backupBook(f.workspace, f.project.id, path.join(f.root, '备份'));
  const outside = path.join(f.root, '其他书'); await fs.mkdir(outside);
  const text = '另一部虚构小说的机密设定'; await fs.writeFile(path.join(outside, '秘密.txt'), text);
  await fs.symlink(outside, path.join(backup.folder, 'book', '链接'), 'junction');
  const file = path.join(backup.folder, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  manifest.entries.push({ path: 'book/链接/秘密.txt', bytes: Buffer.byteLength(text), sha256: digest(text) });
  manifest.files++; manifest.bytes += Buffer.byteLength(text);
  await fs.writeFile(file, JSON.stringify(manifest));
  assert.equal((await verifyBackup(backup.folder)).ok, false, '不能把外部链接当作包内文件');
  await assert.rejects(restoreBackup(backup.folder, path.join(f.root, '恢复')), /校验失败/u);
});

test('备份和 ZIP 必须报告源目录链接，不能静默漏掉或带入另一书的资料', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, '另一书'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, '设定.txt'), '不能串书');
  await fs.symlink(outside, path.join(f.project.root, '链接'), 'junction');
  await assert.rejects(backupBook(f.workspace, f.project.id, path.join(f.root, '备份')), /链接|符号/u);
  await assert.rejects(exportBookZip(f.workspace, f.project.id, path.join(f.root, '整书.zip')), /链接|符号/u);
});

test('清单路径拒绝 Windows 设备名、ADS 和等价名称', () => {
  for (const value of ['a.txt:secret', 'CON.txt', 'sub/aux', 'a./b.txt', 'a /b.txt', 'a\\b.txt', 'a\u0001.txt']) {
    assert.equal(isSafeRelative(value), false, `不能把 ${JSON.stringify(value)} 当作可移植路径`);
  }
  assert.equal(isSafeRelative('正常目录/第一章.docx'), true);
});

test('备份与 ZIP 目标不能在源书或固定资料目录内，也不能通过目标链接绕过', async t => {
  const f = await fixture(t);
  for (const directory of [f.project.root, path.join(f.project.root, '备份'), path.join(f.root, 'materials', f.project.id, '备份')]) {
    await assert.rejects(backupBook(f.workspace, f.project.id, directory), /不能放在本书/u);
    await assert.rejects(exportBookZip(f.workspace, f.project.id, path.join(directory, '整书.zip')), /不能放在本书/u);
  }
  const alias = path.join(f.root, '指回本书'); await fs.symlink(f.project.root, alias, 'junction');
  await assert.rejects(backupBook(f.workspace, f.project.id, path.join(alias, '备份')), /不能放在本书/u);
  assert.equal(await fs.stat(path.join(f.project.root, '备份')).then(() => true).catch(() => false), false, '拒绝操作不能在原书创建目录');
});

test('清单未知版本、跨书ID、合计、重复大小写路径与文件目录冲突都拒绝恢复', async t => {
  const f = await fixture(t);
  const backup = await backupBook(f.workspace, f.project.id, path.join(f.root, '备份'));
  const file = path.join(backup.folder, 'manifest.json'), original = JSON.parse(await fs.readFile(file, 'utf8'));
  const cases: [string, (value: any) => void][] = [
    ['未知版本', value => { value.schemaVersion = 99; }],
    ['非法ID', value => { value.projectId = '../另一书'; }],
    ['跨书合法ID', value => { value.projectId = randomUUID(); }],
    ['文件总数不符', value => { value.files++; }],
    ['合计不符', value => { value.bytes++; }],
    ['资料计数不符', value => { value.materials++; }],
    ['负数大小', value => { value.entries[0].bytes = -1; }],
    ['大小写重复', value => { value.entries.push({ ...value.entries[0], path: value.entries[0].path.toUpperCase() }); value.files++; value.bytes += value.entries[0].bytes; }],
    ['文件目录冲突', value => { value.entries.push({ ...value.entries[0], path: value.entries[0].path + '/child' }); value.files++; value.bytes += value.entries[0].bytes; }]
  ];
  for (const [label, change] of cases) {
    const changed = structuredClone(original); change(changed); await fs.writeFile(file, JSON.stringify(changed));
    assert.equal((await verifyBackup(backup.folder)).ok, false, label);
    await assert.rejects(restoreBackup(backup.folder, path.join(f.root, '恢复')), /校验失败/u, label);
    assert.equal(await fs.stat(path.join(f.root, '恢复')).then(() => true).catch(() => false), false, `${label}不能先创建目标`);
  }
});

test('schema1 正常旧备份仍可验证与恢复，旧资料目录保留兼容', async t => {
  const f = await fixture(t), folder = path.join(f.root, '旧备份');
  await fs.mkdir(path.join(folder, '资料'), { recursive: true });
  const data = '旧版虚构正文'; await fs.writeFile(path.join(folder, '第一章.txt'), data);
  const world = '旧版世界观'; await fs.writeFile(path.join(folder, '资料', '创作笔记.md'), world);
  const metadata = JSON.stringify({ schemaVersion: 1, id: f.project.id, name: '旧备份' });
  await fs.mkdir(path.join(folder, '小说资料')); await fs.writeFile(path.join(folder, '小说资料', 'project.json'), metadata);
  const entries = [
    { path: '第一章.txt', bytes: Buffer.byteLength(data), sha256: digest(data) },
    { path: '资料/创作笔记.md', bytes: Buffer.byteLength(world), sha256: digest(world) },
    { path: '小说资料/project.json', bytes: Buffer.byteLength(metadata), sha256: digest(metadata) }
  ];
  await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify({ schemaVersion: 1, projectId: f.project.id, projectName: '旧备份', createdAt: '2026-10-20T00:00:00Z', files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), materials: 1, entries }));
  assert.equal((await verifyBackup(folder)).ok, true);
  const restored = await restoreBackup(folder, path.join(f.root, '恢复'));
  assert.equal(await fs.readFile(path.join(restored.folder, '第一章.txt'), 'utf8'), data);
  assert.equal(await fs.readFile(path.join(restored.materialsFolder!, '创作笔记.md'), 'utf8'), world);
});

test('恢复出的书再次更新资料和备份，不混淆旧包装与新世界观，旧标记保留历史', async t => {
  const f = await fixture(t);
  const original = await backupBook(f.workspace, f.project.id, path.join(f.root, '备份一'));
  const first = await restoreBackup(original.folder, path.join(f.root, '恢复一'));
  const firstMarker = await fs.readFile(path.join(first.folder, '小说资料', 'restore-materials.json'), 'utf8');
  const fresh = new Workspace(path.join(f.root, '新本机'), path.join(f.root, '新资料'));
  await fresh.initialize(); const project = await fresh.attach(first.folder);
  const initial = await fresh.readNotes(project.id);
  assert.match(initial.value.world, /两次潮汐/u);
  await fresh.saveNotes(project.id, { ...initial.value, world: '月港的潮汐改为每天三次。' }, initial.hash);
  const secondBackup = await backupBook(fresh, project.id, path.join(f.root, '备份二'));
  assert.equal((await verifyBackup(secondBackup.folder)).ok, true);
  const second = await restoreBackup(secondBackup.folder, path.join(f.root, '恢复二'));
  assert.match(await fs.readFile(path.join(second.materialsFolder!, '创作笔记.md'), 'utf8'), /每天三次/u);
  const history = await fs.readdir(path.join(second.folder, '小说资料', 'restore-materials-history'));
  assert.ok(history.length >= 1);
  assert.ok((await Promise.all(history.map(name => fs.readFile(path.join(second.folder, '小说资料', 'restore-materials-history', name), 'utf8')))).includes(firstMarker));
  const oldDirectory = (JSON.parse(firstMarker) as { directory: string }).directory;
  assert.match(await fs.readFile(path.join(second.folder, ...oldDirectory.split('/'), '创作笔记.md'), 'utf8'), /两次潮汐/u, '原有资料包装内容仍保留');
  const latest = new Workspace(path.join(f.root, '第三本机'), path.join(f.root, '第三资料'));
  await latest.initialize(); const attached = await latest.attach(second.folder);
  assert.match((await latest.readNotes(attached.id)).value.world, /每天三次/u, '新机器打开时使用最新资料');
});
