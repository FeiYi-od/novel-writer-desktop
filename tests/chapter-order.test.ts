import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { ChapterOrderStore } from '../src/main/chapter-order';
import { textDocument } from '../src/main/text-import';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-order-test-'));
  t.after(async () => { assert.match(path.relative(os.tmpdir(), root), /^novel-order-test-[^\\/]+$/); await fs.rm(root, { recursive: true, force: true }); });
  const folderA = path.join(root, '小说甲'), folderB = path.join(root, '小说乙'); await fs.mkdir(folderA); await fs.mkdir(folderB);
  const local = path.join(root, 'local'), materials = path.join(root, 'materials'), workspace = new Workspace(local, materials); await workspace.initialize();
  const a = await workspace.attach(folderA), b = await workspace.attach(folderB), order = new ChapterOrderStore(workspace);
  for (const folder of [folderA, folderB]) for (const name of ['第10章.txt', '第2章.txt', '第1章.txt']) await fs.writeFile(path.join(folder, name), '　　临时正文' + name);
  return { root, folderA, folderB, local, materials, workspace, a, b, order, file: path.join(folderA, '小说资料/chapter-order.json') };
}

test('章节全书排列持久化、两书隔离、正文与资料不改写，内容编辑不使排序基准失效', async t => {
  const f = await fixture(t), initial = await f.order.read(f.a.id);
  assert.deepEqual(initial.value.paths, ['第1章.txt', '第2章.txt', '第10章.txt']);
  const original = new Map(await Promise.all(initial.value.paths.map(async p => [p, await fs.readFile(path.join(f.folderA, p))] as const)));
  const notesBefore = await f.workspace.readNotes(f.a.id);
  const sorted = await f.order.save(f.a.id, [...initial.value.paths].reverse(), initial.hash);
  assert.deepEqual(sorted.value.paths, ['第10章.txt', '第2章.txt', '第1章.txt']);
  assert.deepEqual((await f.order.read(f.b.id)).value.paths, initial.value.paths);
  for (const [p, bytes] of original) assert.deepEqual(await fs.readFile(path.join(f.folderA, p)), bytes);
  assert.deepEqual(await f.workspace.readNotes(f.a.id), notesBefore);
  await fs.writeFile(path.join(f.folderA, '第2章.txt'), '　　外部编辑正文不改变章节清单');
  assert.equal((await f.order.read(f.a.id)).hash, sorted.hash);
  const next = await f.order.save(f.a.id, initial.value.paths, sorted.hash);
  assert.equal((await fs.readdir(path.join(f.folderA, '小说资料/chapter-order-history'))).length, 1);
  const restarted = new Workspace(f.local, f.materials); await restarted.initialize();
  assert.deepEqual(await new ChapterOrderStore(restarted).read(f.a.id), next);
});

test('保存末次复核拒绝目录竞态，首次发布不覆盖外部新记录，过大记录不能落盘', async t => {
  const f = await fixture(t), initial = await f.order.read(f.a.id), scan = f.workspace.chapters.bind(f.workspace);
  let scans = 0;
  f.workspace.chapters = async id => { if (++scans === 2) await fs.writeFile(path.join(f.folderA, '突入.txt'), '　　外部新增'); return scan(id); };
  await assert.rejects(f.order.save(f.a.id, [...initial.value.paths].reverse(), initial.hash), /保存期间|变化/);
  await assert.rejects(fs.stat(f.file), /ENOENT/);
  f.workspace.chapters = scan; const fresh = await f.order.read(f.a.id); scans = 0;
  const external = JSON.stringify(fresh.value);
  f.workspace.chapters = async id => { if (++scans === 2) await fs.writeFile(f.file, external, { flag: 'wx' }); return scan(id); };
  await assert.rejects(f.order.save(f.a.id, [...fresh.value.paths].reverse(), fresh.hash), /EEXIST|变化/);
  assert.equal(await fs.readFile(f.file, 'utf8'), external);
  assert.equal((await fs.readdir(path.dirname(f.file))).some(name => name.endsWith('.order.tmp')), false);
  f.workspace.chapters = scan;
  const huge = Array.from({ length: 1200 }, (_, i) => ({ path: `${'段'.repeat(630)}/${i}.txt`, name: `${i}.txt` }));
  f.workspace.chapters = async () => huge;
  const oversized = await f.order.read(f.b.id);
  await assert.rejects(f.order.save(f.b.id, [...oversized.value.paths].reverse(), oversized.hash), /2MiB/);
  await assert.rejects(fs.stat(path.join(f.folderB, '小说资料/chapter-order.json')), /ENOENT/);
});

test('新增章节自然追加、缺失位置保留，目录与外部排序变化拒绝旧基准', async t => {
  const f = await fixture(t), initial = await f.order.read(f.a.id), saved = await f.order.save(f.a.id, [...initial.value.paths].reverse(), initial.hash);
  const displaced = path.join(f.root, '移出的测试.txt'); await fs.rename(path.join(f.folderA, '第2章.txt'), displaced);
  await fs.writeFile(path.join(f.folderA, '第0章新.txt'), '　　新增');
  const changed = await f.order.read(f.a.id);
  assert.deepEqual(changed.value.paths, ['第10章.txt', '第2章.txt', '第1章.txt', '第0章新.txt']);
  assert.equal(changed.entries[1].present, false); assert.equal(changed.entries[3].present, true);
  await assert.rejects(f.order.save(f.a.id, saved.value.paths, saved.hash), /变化|刷新/);
  for (const paths of [changed.value.paths.slice(1), [...changed.value.paths, '第2章.txt'], [...changed.value.paths.slice(0, -1), '未知.txt']]) await assert.rejects(f.order.save(f.a.id, paths, changed.hash), /完整|重复|遗漏/);
  const persisted = await f.order.save(f.a.id, changed.value.paths, changed.hash);
  await fs.rename(displaced, path.join(f.folderA, '第2章.txt'));
  const restored = await f.order.read(f.a.id); assert.equal(restored.entries[1].present, true); assert.deepEqual(restored.value.paths, persisted.value.paths);
  await assert.rejects(f.order.save(f.a.id, persisted.value.paths, persisted.hash), /变化|刷新/);
  const external = JSON.stringify({ ...restored.value, paths: [...restored.value.paths].reverse() }); await fs.writeFile(f.file, external);
  await assert.rejects(f.order.save(f.a.id, restored.value.paths, restored.hash), /变化|刷新/); assert.equal(await fs.readFile(f.file, 'utf8'), external);
});

test('连续重命名保序，历史别名大小写重复与跨书记录、未知格式及越界路径拒绝并保留', async t => {
  const f = await fixture(t), initial = await f.order.read(f.a.id), saved = await f.order.save(f.a.id, [...initial.value.paths].reverse(), initial.hash);
  const source = await f.workspace.readChapter(f.a.id, '第2章.txt');
  const renamed = await f.workspace.renameChapter({ projectId: f.a.id, path: source.path, expectedHash: source.hash, name: '第二章' });
  const twice = await f.workspace.renameChapter({ projectId: f.a.id, path: renamed.path, expectedHash: renamed.hash, name: '第二章新版' });
  const projected = await f.order.read(f.a.id); assert.deepEqual(projected.value.paths, ['第10章.txt', twice.path, '第1章.txt']);
  await assert.rejects(f.order.save(f.a.id, saved.value.paths, saved.hash), /变化|刷新/);
  const raw = await fs.readFile(f.file);
  const bad = [
    { ...projected.value, projectId: f.b.id }, { ...projected.value, schemaVersion: 99 },
    { ...projected.value, paths: ['../小说乙/第1章.txt'] }, { ...projected.value, paths: ['小说资料/资料.txt'] },
    { ...projected.value, paths: [source.path, twice.path] },
    { ...projected.value, paths: ['Nested/a.txt', 'nested\\A.txt'] }, { ...projected.value, paths: ['非法.md'] }
  ];
  for (const value of bad) { const text = JSON.stringify(value); await fs.writeFile(f.file, text); await assert.rejects(f.order.read(f.a.id)); assert.equal(await fs.readFile(f.file, 'utf8'), text); }
  await fs.writeFile(f.file, raw); await fs.unlink(f.file); await fs.mkdir(f.file); await assert.rejects(f.order.read(f.a.id), /文件类型/); await fs.rmdir(f.file); await fs.writeFile(f.file, raw);
  // Managed DOCX is also left byte-identical by the metadata-only operation.
  const docx = await f.workspace.createChapter(f.a.id, textDocument('　　测试DOCX')); const bytes = await fs.readFile(path.join(f.folderA, docx.path));
  const fresh = await f.order.read(f.a.id); await f.order.save(f.a.id, [...fresh.value.paths].reverse(), fresh.hash); assert.deepEqual(await fs.readFile(path.join(f.folderA, docx.path)), bytes);
});
