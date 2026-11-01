import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import fsMutable from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workspace } from '../src/main/workspace';
import { RecoveryStore, listRawDrafts, readRawDraft, restoreRawDraft, pruneRawDrafts, listPreviousVersions, readPreviousVersion, restorePreviousVersion, prunePreviousVersions } from '../src/main/recovery';
import { textDocument } from '../src/main/text-import';

async function fixture() {
  const root = await fs.mkdtemp(path.resolve('.artifacts/recovery-root-race-059-'));
  const data = path.join(root, 'data'), book = path.join(root, '虚构甲书'), other = path.join(root, '虚构乙书');
  await fs.mkdir(book); await fs.mkdir(other);
  const workspace = new Workspace(data); await workspace.initialize();
  const project = await workspace.attach(book), chapter = await workspace.createChapter(project.id, textDocument('　　虚构原稿'));
  const request = { projectId: project.id, id: randomUUID(), path: chapter.path, expectedHash: chapter.hash, revision: 1, content: textDocument('　　仅属于甲书的草稿') };
  return { root, data, book, other, workspace, project, chapter, request };
}
const junction = (target: string, link: string) => fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');

test('checkpoint 恢复根是另一书 junction 时拒绝读写，不创建跨书目录', async () => {
  const f = await fixture(), root = path.join(f.data, 'recovery-checkpoints');
  await fs.writeFile(path.join(f.other, '保留.txt'), '乙书原件'); await junction(f.other, root);
  const store = new RecoveryStore(root, f.workspace);
  await assert.rejects(store.checkpoint(f.request), /目录|链接|越界/u);
  await assert.rejects(store.list(f.project.id), /目录|链接|越界/u);
  assert.deepEqual(await fs.readdir(f.other), ['保留.txt']);
});

test('原始/历史恢复的根是另一目录 junction 时所有查看、恢复和清理入口拒绝', async () => {
  const f = await fixture(), root = path.join(f.data, 'recovery'), directory = path.join(f.other, f.project.id);
  await fs.mkdir(directory); const draft = `1792000000000-${randomUUID()}-draft.txt`, previous = draft.replace('-draft.txt', '-previous.txt');
  for (const file of [draft, previous]) await fs.writeFile(path.join(directory, file), '虚构备份原件');
  await junction(f.other, root);
  for (const action of [
    () => listRawDrafts(root, f.project.id), () => readRawDraft(root, f.project.id, draft), () => restoreRawDraft(root, f.project.id, draft, f.book), () => pruneRawDrafts(root, f.project.id),
    () => listPreviousVersions(root, f.project.id), () => readPreviousVersion(root, f.project.id, previous), () => restorePreviousVersion(root, f.project.id, previous, f.book), () => prunePreviousVersions(root, f.project.id)
  ]) await assert.rejects(action, /目录|链接|越界/u);
  assert.deepEqual((await fs.readdir(directory)).sort(), [draft, previous].sort());
  assert.equal(await fs.readFile(path.join(directory, draft), 'utf8'), '虚构备份原件');
});

test('checkpoint 临时写入后恢复根变成 junction：不向新目标发布草稿', async t => {
  const f = await fixture(), root = path.join(f.data, 'recovery-checkpoints'), moved = root + '-原目录';
  const store = new RecoveryStore(root, f.workspace); await fs.mkdir(root); let injected = false;
  const original = fsMutable.open.bind(fsMutable);
  t.mock.method(fsMutable, 'open', async (...args: Parameters<typeof fsMutable.open>) => {
    const handle = await original(...args);
    if (typeof args[0] === 'string' && args[0].startsWith(root) && args[0].endsWith('.tmp')) {
      const close = handle.close.bind(handle);
      (handle as any).close = async () => {
        await close();
        if (!injected) { injected = true; await fs.rename(root, moved); await junction(f.other, root); }
      };
    }
    return handle;
  });
  await assert.rejects(store.checkpoint(f.request), /目录|链接|越界|变化/u);
  assert.equal(injected, true); assert.deepEqual(await fs.readdir(f.other), []);
});

test('读取备份时恢复根被替换为 junction，拒绝返回旧内容或读新位置', async t => {
  const f = await fixture(), root = path.join(f.data, 'recovery'), dir = path.join(root, f.project.id), moved = root + '-原目录';
  await fs.mkdir(dir, { recursive: true }); const id = `1792000000000-${randomUUID()}-draft.txt`, file = path.join(dir, id);
  await fs.writeFile(file, '虚构原始备份'); let injected = false;
  const original = fsMutable.readFile.bind(fsMutable);
  t.mock.method(fsMutable, 'readFile', async (...args: Parameters<typeof fsMutable.readFile>) => {
    const bytes = await original(...args);
    if (!injected && typeof args[0] === 'string' && path.resolve(args[0]) === path.resolve(file)) {
      injected = true; await fs.rename(root, moved); await junction(f.other, root);
    }
    return bytes;
  });
  await assert.rejects(readRawDraft(root, f.project.id, id), /目录|链接|越界|变化/u);
  assert.equal(injected, true); assert.deepEqual(await fs.readdir(f.other), []);
  assert.equal(await fs.readFile(path.join(moved, f.project.id, id), 'utf8'), '虚构原始备份');
});

test('checkpoint 写暂存期间恢复根被同字节重建：不在新根发布或清理对方文件', async t => {
  const f = await fixture(), root = path.join(f.data, 'recovery-checkpoints'), moved = root + '-原目录';
  const store = new RecoveryStore(root, f.workspace); await fs.mkdir(root); let injected = false;
  const original = fsMutable.open.bind(fsMutable);
  t.mock.method(fsMutable, 'open', async (...args: Parameters<typeof fsMutable.open>) => {
    const handle = await original(...args);
    if (typeof args[0] === 'string' && args[0].startsWith(root) && args[0].endsWith('.tmp')) {
      const close = handle.close.bind(handle);
      (handle as any).close = async () => {
        await close();
        if (!injected) { injected = true; await fs.rename(root, moved); await fs.cp(moved, root, { recursive: true }); }
      };
    }
    return handle;
  });
  await assert.rejects(store.checkpoint(f.request), /目录|变化/u);
  assert.equal(injected, true);
  assert.equal((await fs.readdir(path.join(root, f.project.id))).filter(name => name.endsWith('.json')).length, 0);
  assert.equal((await fs.readdir(path.join(moved, f.project.id))).filter(name => name.endsWith('.json')).length, 0);
  assert.equal((await fs.readdir(path.join(root, f.project.id))).filter(name => name.endsWith('.tmp')).length, 1, '新目录的暂存文件可能已被外部进程替换，不能擅自删除');
});

test('checkpoint 创建暂存文件前恢复根被重建：新根不能收到敏感草稿内容', async t => {
  const f = await fixture(), root = path.join(f.data, 'recovery-checkpoints'), moved = root + '-原目录';
  const store = new RecoveryStore(root, f.workspace); await fs.mkdir(root); let injected = false;
  const inject = async (target: unknown) => {
    if (!injected && typeof target === 'string' && target.startsWith(root) && target.endsWith('.tmp')) {
      injected = true; await fs.rename(root, moved); await fs.mkdir(path.join(root, f.project.id), { recursive: true });
    }
  };
  const originalWrite = fsMutable.writeFile.bind(fsMutable), originalOpen = fsMutable.open.bind(fsMutable);
  t.mock.method(fsMutable, 'writeFile', async (...args: Parameters<typeof fsMutable.writeFile>) => { await inject(args[0]); return originalWrite(...args); });
  t.mock.method(fsMutable, 'open', async (...args: Parameters<typeof fsMutable.open>) => { await inject(args[0]); return originalOpen(...args); });
  await assert.rejects(store.checkpoint(f.request), /目录|变化/u);
  assert.equal(injected, true);
  for (const name of await fs.readdir(path.join(root, f.project.id))) {
    const bytes = await fs.readFile(path.join(root, f.project.id, name));
    assert.equal(bytes.length, 0, '新目录中最多留下空暂存，不得写入草稿正文');
  }
});

test('备份清理列目录期间根同路径重建，不能删除新目录里的外部更新', async t => {
  const f = await fixture(), root = path.join(f.data, 'recovery'), directory = path.join(root, f.project.id), moved = root + '-原目录';
  await fs.mkdir(directory, { recursive: true });
  const old = `1792000000000-${randomUUID()}-draft.txt`, recent = `1792000000001-${randomUUID()}-draft.txt`;
  for (const [name, at] of [[old, '2020-01-01T00:00:00.000Z'], [recent, '2021-01-01T00:00:00.000Z']]) {
    await fs.writeFile(path.join(directory, name), '虚构原备份');
    await fs.writeFile(path.join(directory, name.replace('-draft.txt', '-draft.meta.json')), JSON.stringify({ schemaVersion: 1, at, sourcePath: '虚构.txt' }));
  }
  const original = fsMutable.readdir.bind(fsMutable); let injected = false;
  t.mock.method(fsMutable, 'readdir', async (...args: Parameters<typeof fsMutable.readdir>) => {
    const list = await original(...args);
    if (!injected && typeof args[0] === 'string' && path.resolve(args[0]) === path.resolve(directory)) {
      injected = true; await fs.rename(root, moved); await fs.cp(moved, root, { recursive: true });
      await fs.writeFile(path.join(directory, old), '外部新备份，不能被删除');
    }
    return list;
  });
  await assert.rejects(pruneRawDrafts(root, f.project.id, { keep: 1, olderThanDays: 0 }), /变化|目录/u);
  assert.equal(injected, true); assert.equal(await fs.readFile(path.join(directory, old), 'utf8'), '外部新备份，不能被删除');
  assert.equal(await fs.readFile(path.join(moved, f.project.id, old), 'utf8'), '虚构原备份');
});

test('清理读取选中备份时外部改写该文件，拒绝删除新内容', async t => {
  const f = await fixture(), root = path.join(f.data, 'recovery'), directory = path.join(root, f.project.id);
  await fs.mkdir(directory, { recursive: true });
  const old = `1792000000000-${randomUUID()}-draft.txt`, recent = `1792000000001-${randomUUID()}-draft.txt`;
  for (const [name, at] of [[old, '2020-01-01T00:00:00.000Z'], [recent, '2021-01-01T00:00:00.000Z']]) {
    await fs.writeFile(path.join(directory, name), '虚构原备份');
    await fs.writeFile(path.join(directory, name.replace('-draft.txt', '-draft.meta.json')), JSON.stringify({ schemaVersion: 1, at, sourcePath: '虚构.txt' }));
  }
  const original = fsMutable.readFile.bind(fsMutable), target = path.join(directory, old); let injected = false;
  t.mock.method(fsMutable, 'readFile', async (...args: Parameters<typeof fsMutable.readFile>) => {
    const raw = await original(...args);
    if (!injected && typeof args[0] === 'string' && path.resolve(args[0]) === path.resolve(target)) {
      injected = true; await fs.writeFile(target, '外部新修改');
    }
    return raw;
  });
  await assert.rejects(pruneRawDrafts(root, f.project.id, { keep: 1, olderThanDays: 0 }), /变化|备份/u);
  assert.equal(injected, true); assert.equal(await fs.readFile(target, 'utf8'), '外部新修改');
});
