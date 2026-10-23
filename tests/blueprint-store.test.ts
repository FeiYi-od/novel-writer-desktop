import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { BlueprintStore } from '../src/main/blueprint';
import { normalizeBlueprint, type BlueprintNode } from '../src/core/blueprint';
import { textDocument } from '../src/main/text-import';

const node = (scope: 'volume' | 'chapter', ref: string, extra: Partial<BlueprintNode> = {}): BlueprintNode =>
  normalizeBlueprint({ scope, ref, goals: '推进主线', ...extra });
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-blueprint-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials'));
  await workspace.initialize();
  const book = path.join(root, '甲'); await fs.mkdir(book);
  const project = await workspace.attach(book);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const chapter = await workspace.createChapter(project.id, textDocument('虚构正文。'));
  return { root, workspace, project, chapter, store: new BlueprintStore(workspace) };
}

test('蓝图存储：保存读回，章节蓝图记录来源版本', async t => {
  const f = await fixture(t);
  const empty = await f.store.read(f.project.id);
  assert.deepEqual(empty.nodes, []);
  const saved = await f.store.save(f.project.id, [node('volume', 'v1'), node('chapter', f.chapter.path, { sourceHash: f.chapter.hash })], empty.hash);
  assert.equal(saved.nodes.length, 2);
  assert.ok(saved.nodes.every(item => item.id.length === 36));
  assert.deepEqual(saved.stale, [], '刚写的蓝图不应过期');
  const reloaded = await f.store.read(f.project.id);
  assert.equal(reloaded.nodes.length, 2);
  assert.equal(reloaded.hash, saved.hash);
});

test('蓝图存储：正文改动后章节蓝图标记过期，分卷蓝图不受影响', async t => {
  const f = await fixture(t);
  const first = await f.store.save(f.project.id, [node('chapter', f.chapter.path, { sourceHash: f.chapter.hash }), node('volume', 'v1')], '');
  const edited = await f.workspace.readChapter(f.project.id, f.chapter.path);
  await f.workspace.saveChapter({ projectId: f.project.id, path: f.chapter.path, expectedHash: edited.hash, content: textDocument('改写后的正文。') });
  const after = await f.store.read(f.project.id);
  assert.equal(after.hash, first.hash, '正文改动不影响蓝图文件哈希');
  assert.deepEqual(after.stale.map(item => item.ref), [f.chapter.path], '只有章节蓝图过期');
});

test('蓝图存储：并发修改与重复蓝图被拒绝，覆盖保存留历史', async t => {
  const f = await fixture(t);
  const first = await f.store.save(f.project.id, [node('chapter', f.chapter.path)], '');
  await assert.rejects(f.store.save(f.project.id, [node('chapter', f.chapter.path, { goals: '改' })], 'deadbeef'), /已被其他窗口修改/u);
  await assert.rejects(f.store.save(f.project.id, [node('chapter', f.chapter.path), node('chapter', f.chapter.path, { goals: '二' })], first.hash), /只能有一份/u);
  await f.store.save(f.project.id, [node('chapter', f.chapter.path, { goals: '新目标' })], first.hash);
  const history = await fs.readdir(path.join(f.project.root, '小说资料', '蓝图历史')).catch(() => [] as string[]);
  assert.ok(history.length >= 1);
});
