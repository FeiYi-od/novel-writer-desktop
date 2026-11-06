import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { StoryMemoryStore } from '../src/main/story-memory';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-memory-rm-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials')); await workspace.initialize();
  const parent = path.join(root, 'books'); await fs.mkdir(parent);
  const project = await workspace.createProject(parent, '记忆书');
  const directory = path.join(parent, '记忆书'); await fs.mkdir(directory, { recursive: true });
  const chapter = path.join(directory, '第一章.docx');
  await fs.writeFile(chapter, Buffer.from('章节正文'), 'utf8');
  const memory = new StoryMemoryStore(workspace, path.join(root, 'materials'));
  return { root, workspace, project, memory, chapter };
}

async function add(memory: StoryMemoryStore, workspace: Workspace, projectId: string, chapter: string, content: string) {
  const snapshot = await memory.read(projectId);
  const relative = '第一章.docx';
  const sourceHash = await workspace.chapterHash(projectId, relative);
  return memory.add(projectId, {
    id: crypto.randomUUID(), projectId, sourcePath: relative, sourceHash, content,
    taskId: crypto.randomUUID(), model: 'fixture', createdAt: new Date().toISOString(), enabled: true, important: false
  }, snapshot.hash);
}

test('批量删除摘要：选中的条目消失、其余保留、哈希失效拒绝', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const first = await add(f.memory, f.workspace, f.project.project.id, f.chapter, '第一段摘要');
  const second = await add(f.memory, f.workspace, f.project.project.id, f.chapter, '第二段摘要');
  const keep = await add(f.memory, f.workspace, f.project.project.id, f.chapter, '要保留的摘要');
  const ids = keep.value.entries.map(entry => entry.id);
  assert.equal(ids.length, 3);
  const target = [keep.value.entries[0]!.id, keep.value.entries[1]!.id];
  const after = await f.memory.removeEntries(f.project.project.id, target, keep.hash);
  assert.equal(after.value.entries.length, 1);
  assert.equal(after.value.entries[0]!.content, '要保留的摘要');
  await assert.rejects(f.memory.removeEntries(f.project.project.id, target, keep.hash), /不存在|已删除/u);
  assert.equal(first.value.entries.length, 1);
});

test('批量删除摘要：空列表、重复 ID、跨书都拒绝且不改文件', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const snapshot = await add(f.memory, f.workspace, f.project.project.id, f.chapter, '唯一摘要');
  const entryId = snapshot.value.entries[0]!.id;
  assert.throws(() => f.memory.removeEntries(f.project.project.id, [], snapshot.hash), /至少|min|1/u as unknown as RegExp);
  await assert.rejects(f.memory.removeEntries(f.project.project.id, [entryId, entryId], snapshot.hash), /重复/u);
  const other = await f.workspace.createProject(path.dirname(f.project.root), '别的书');
  await assert.rejects(f.memory.removeEntries(other.project.id, [entryId], snapshot.hash), /不存在|已删除/u);
  assert.equal((await f.memory.read(f.project.project.id)).value.entries.length, 1);
});
