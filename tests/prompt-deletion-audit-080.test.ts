import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { PromptLibraryStore, PromptDeletionLog } from '../src/main/prompt-library';
import type { PromptTemplate } from '../src/core/prompt-library';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-prompt-audit-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials')); await workspace.initialize();
  const parent = path.join(root, 'books'); await fs.mkdir(parent);
  const project = await workspace.createProject(parent, '提示词书');
  const store = new PromptLibraryStore(workspace);
  const log = new PromptDeletionLog(workspace);
  return { root, workspace, project, store, log };
}

const template = (name: string, body = '正文提示'): PromptTemplate => ({
  id: crypto.randomUUID(), name, kind: 'write', body, version: 1, updatedAt: new Date().toISOString(), versions: []
});

test('删除提示词会写入删除审计，保留名称/类型/版本数/时间', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const keep = template('保留的模板'), drop = template('要删的模板');
  let snapshot = await f.store.save(f.project.project.id, [keep, drop], '');
  assert.deepEqual(await f.log.read(f.project.project.id), { items: [], hash: '' }, '保存新增不应产生删除记录');
  snapshot = await f.store.save(f.project.project.id, [keep], snapshot.hash);
  const audit = await f.log.read(f.project.project.id);
  assert.equal(audit.items.length, 1);
  assert.equal(audit.items[0]!.name, '要删的模板');
  assert.equal(audit.items[0]!.kind, 'write');
  assert.equal(audit.items[0]!.versions, 1);
  assert.ok(audit.items[0]!.removedAt);
});

test('删除审计：重复保存不重复记录，旧哈希被拒时不写审计', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const keep = template('A'), drop = template('B');
  let snapshot = await f.store.save(f.project.project.id, [keep, drop], '');
  snapshot = await f.store.save(f.project.project.id, [keep], snapshot.hash);
  await f.store.save(f.project.project.id, [keep], snapshot.hash);
  assert.equal((await f.log.read(f.project.project.id)).items.length, 1, '同一删除只记一次');
  await assert.rejects(f.store.save(f.project.project.id, [], 'stale'), /已被其他窗口修改|刷新/u);
  assert.equal((await f.log.read(f.project.project.id)).items.length, 1, '被拒绝的保存不能留下审计');
  const empty = await f.log.read(f.project.project.id);
  assert.equal(empty.items[0]!.name, 'B');
});
