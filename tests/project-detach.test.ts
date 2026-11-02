import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';

async function fixture(t: TestContext) {
  await fs.mkdir(path.resolve('.artifacts'), { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.artifacts/project-detach-'));
  const local = path.join(root, 'local'), materials = path.join(root, 'materials');
  const first = path.join(root, '虚构甲'), second = path.join(root, '虚构乙');
  await fs.mkdir(first); await fs.mkdir(second);
  const workspace = new Workspace(local, materials); await workspace.initialize();
  const a = await workspace.attach(first), b = await workspace.attach(second);
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve('.artifacts'));
    assert.match(path.basename(root), /^project-detach-[A-Za-z0-9]+$/u);
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, local, materials, first, second, workspace, a, b };
}

test('移除仅取消本机书架关联，重启后不出现，重新关联保留原 ID 和资料', async t => {
  const f = await fixture(t);
  const originalFile = path.join(f.first, '正文.txt');
  const manuscript = Buffer.from('　　虚构章节。\n', 'utf8'); await fs.writeFile(originalFile, manuscript);
  const metadata = path.join(f.first, '小说资料', 'project.json'); const originalMetadata = await fs.readFile(metadata);
  const notes = await f.workspace.readNotes(f.a.id);
  await f.workspace.saveNotes(f.a.id, { ...notes.value, world: '虚构世界观。' }, notes.hash);
  const beforeNotes = await fs.readFile(path.join(f.materials, f.a.id, '创作笔记.md'));
  const offline = path.join(f.root, '离线书');
  const index = path.join(f.local, 'library.json');
  await fs.writeFile(index, JSON.stringify([f.first, offline, f.second]));
  await f.workspace.detach(f.a.id);
  assert.deepEqual(f.workspace.listProjects().map(p => p.id), [f.b.id]);
  assert.deepEqual(JSON.parse(await fs.readFile(index, 'utf8')), [offline, f.second]);
  assert.deepEqual(await fs.readFile(metadata), originalMetadata);
  assert.deepEqual(await fs.readFile(originalFile), manuscript);
  assert.deepEqual(await fs.readFile(path.join(f.materials, f.a.id, '创作笔记.md')), beforeNotes);
  const restarted = new Workspace(f.local, f.materials); await restarted.initialize();
  assert.deepEqual(restarted.listProjects().map(p => p.id), [f.b.id]);
  assert.equal((await restarted.attach(f.first)).id, f.a.id);
  assert.deepEqual(await fs.readFile(originalFile), manuscript);
  assert.deepEqual(await fs.readFile(path.join(f.materials, f.a.id, '创作笔记.md')), beforeNotes);
  assert.ok(JSON.parse(await fs.readFile(index, 'utf8')).includes(offline));
});

test('未知 ID、损坏索引和写入失败均不丢失内存关联及原索引', async t => {
  const f = await fixture(t), index = path.join(f.local, 'library.json');
  const original = await fs.readFile(index);
  await assert.rejects(f.workspace.detach('42b9dfd8-c7d9-495d-b63f-a1087178af55'), /未关联/u);
  await fs.writeFile(index, '{broken');
  await assert.rejects(f.workspace.detach(f.a.id), /损坏/u);
  assert.equal(f.workspace.getProject(f.a.id).id, f.a.id);
  assert.equal(await fs.readFile(index, 'utf8'), '{broken');
  await fs.writeFile(index, original);
  const native = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises');
  const write = native.writeFile;
  (native as any).writeFile = async (...args: any[]) => {
    if (String(args[0]).startsWith(index + '.') && String(args[0]).endsWith('.tmp')) throw new Error('simulated failure');
    return (write as any)(...args);
  };
  try { await assert.rejects(f.workspace.detach(f.a.id), /simulated failure/u); }
  finally { (native as any).writeFile = write; }
  assert.equal(f.workspace.getProject(f.a.id).id, f.a.id);
  assert.deepEqual(await fs.readFile(index), original);
});

test('暂存期间外部修改索引时拒绝并保留外部内容与内存关联', async t => {
  const f = await fixture(t), index = path.join(f.local, 'library.json');
  const external = JSON.stringify([f.first, f.second, path.join(f.root, '外部新增')]);
  const native = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises');
  const write = native.writeFile; let changed = false;
  (native as any).writeFile = async (...args: any[]) => {
    const result = await (write as any)(...args);
    if (!changed && String(args[0]).startsWith(index + '.') && String(args[0]).endsWith('.tmp')) { changed = true; await write(index, external); }
    return result;
  };
  try { await assert.rejects(f.workspace.detach(f.a.id), /变化/u); }
  finally { (native as any).writeFile = write; }
  assert.equal(await fs.readFile(index, 'utf8'), external);
  assert.equal(f.workspace.getProject(f.a.id).id, f.a.id);
});

test('书库暂存内容被替换时拒绝提交并保留原索引', async t => {
  const f = await fixture(t), index = path.join(f.local, 'library.json');
  const original = await fs.readFile(index);
  const native = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises');
  const write = native.writeFile; let changed = false, temporary = '';
  (native as any).writeFile = async (...args: any[]) => {
    const result = await (write as any)(...args), file = String(args[0]);
    if (!changed && file.startsWith(index + '.') && file.endsWith('.tmp')) { changed = true; temporary = file; await write(file, '[]'); }
    return result;
  };
  try { await assert.rejects(f.workspace.detach(f.a.id), /暂存文件已变化/u); }
  finally { (native as any).writeFile = write; }
  assert.deepEqual(await fs.readFile(index), original);
  assert.equal(await fs.readFile(temporary, 'utf8'), '[]');
  assert.equal(f.workspace.getProject(f.a.id).id, f.a.id);
});

test('书库索引为硬链接时拒绝更改', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), index = path.join(f.local, 'library.json'), link = path.join(f.root, 'other.json');
  await fs.link(index, link);
  const original = await fs.readFile(index);
  await assert.rejects(f.workspace.detach(f.a.id), /不安全/u);
  assert.deepEqual(await fs.readFile(link), original);
  assert.equal(f.workspace.getProject(f.a.id).id, f.a.id);
});

test('索引目录被替换时不清理新目录中同名文件', async t => {
  const f = await fixture(t), index = path.join(f.local, 'library.json');
  const original = await fs.readFile(index), moved = path.join(f.root, '原索引目录');
  const native = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises');
  const write = native.writeFile; let replacement = '';
  (native as any).writeFile = async (...args: any[]) => {
    const result = await (write as any)(...args);
    const file = String(args[0]);
    if (!replacement && file.startsWith(index + '.') && file.endsWith('.tmp')) {
      replacement = path.basename(file);
      await fs.rename(f.local, moved); await fs.mkdir(f.local);
      await write(path.join(f.local, replacement), '外部保留文件');
      await write(index, original);
    }
    return result;
  };
  try { await assert.rejects(f.workspace.detach(f.a.id), /变化/u); }
  finally { (native as any).writeFile = write; }
  assert.equal(await fs.readFile(path.join(f.local, replacement), 'utf8'), '外部保留文件');
  assert.deepEqual(await fs.readFile(path.join(moved, 'library.json')), original);
  assert.equal(f.workspace.getProject(f.a.id).id, f.a.id);
});
