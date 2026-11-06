import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { LibraryStore } from '../src/main/library';
import { CharacterStore } from '../src/main/characters';
import { AIService } from '../src/main/ai-service';
import type { AIConnections } from '../src/main/ai-connections';

// 任务记录只用本机 JSON 夹具，不调用任何模型。
const connectionId = crypto.randomUUID();
const task = (id: string, projectId: string, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1, id, projectId, mode: 'write', chapterPath: '第一章.docx', sourceHash: 'a'.repeat(64),
  instruction: '写', connection: {
    id: connectionId, name: '夹具连接', model: 'm', baseUrl: 'https://api.example.com/v1', adapter: 'generic',
    thinking: 'default', timeoutSeconds: 300, contextWindow: 8192, maxOutputTokens: 1024, tokenParameter: 'max_tokens'
  },
  createdAt: new Date().toISOString(), status: 'complete', text: '输出', error: '', finishReason: 'stop',
  contextHash: 'b'.repeat(64), context: '', sourceText: '正文',
  ...extra
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-aitask-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials')); await workspace.initialize();
  const parent = path.join(root, 'books'); await fs.mkdir(parent);
  const project = await workspace.createProject(parent, '任务书');
  const library = new LibraryStore(id => workspace.getProject(id), path.join(root, 'materials'));
  const characters = new CharacterStore(id => workspace.getProject(id), path.join(root, 'materials'));
  const service = new AIService(path.join(root, 'state'), {} as unknown as AIConnections, workspace, library, characters);
  const folder = path.join(root, 'state', 'ai-tasks', project.project.id);
  await fs.mkdir(folder, { recursive: true });
  return { root, workspace, project, service, folder };
}

test('删除任务记录：已结束的记录可以从历史里移除，文件同时消失', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const id = crypto.randomUUID();
  await fs.writeFile(path.join(f.folder, `${id}.json`), JSON.stringify(task(id, f.project.project.id)), 'utf8');
  assert.equal((await f.service.list(f.project.project.id)).length, 1);
  await f.service.removeTask(f.project.project.id, id);
  assert.deepEqual(await f.service.list(f.project.project.id), []);
  assert.equal(await fs.stat(path.join(f.folder, `${id}.json`)).then(() => true).catch(() => false), false);
});

test('删除任务记录：运行中、被审稿引用、未知 id 都拒绝且不删文件', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const parentId = crypto.randomUUID(), childId = crypto.randomUUID();
  await fs.writeFile(path.join(f.folder, `${parentId}.json`), JSON.stringify(task(parentId, f.project.project.id, { status: 'running' })), 'utf8');
  await fs.writeFile(path.join(f.folder, `${childId}.json`), JSON.stringify(task(childId, f.project.project.id, { mode: 'review', reviewTaskId: parentId })), 'utf8');
  await assert.rejects(f.service.removeTask(f.project.project.id, parentId), /运行|引用/u);
  await assert.rejects(f.service.removeTask(f.project.project.id, crypto.randomUUID()), /不存在|已删除/u);
  assert.equal((await f.service.list(f.project.project.id)).length, 2, '拒绝时记录必须保留');
  await fs.writeFile(path.join(f.folder, `${parentId}.json`), JSON.stringify(task(parentId, f.project.project.id)), 'utf8');
  await assert.rejects(f.service.removeTask(f.project.project.id, parentId), /引用/u);
  await f.service.removeTask(f.project.project.id, childId);
  await f.service.removeTask(f.project.project.id, parentId);
  assert.deepEqual(await f.service.list(f.project.project.id), []);
});

test('删除任务记录：别的书不能删本书任务', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const other = await f.workspace.createProject(path.dirname(f.project.root), '别的书');
  const id = crypto.randomUUID();
  await fs.writeFile(path.join(f.folder, `${id}.json`), JSON.stringify(task(id, f.project.project.id)), 'utf8');
  await assert.rejects(f.service.removeTask(other.project.id, id), /不存在/u);
  assert.equal((await f.service.list(f.project.project.id)).length, 1);
});
