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

const connectionId = crypto.randomUUID();
const task = (id: string, projectId: string, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1, id, projectId, mode: 'review', chapterPath: '第一章.docx', sourceHash: 'a'.repeat(64),
  instruction: '审', connection: {
    id: connectionId, name: '夹具连接', model: 'm', baseUrl: 'https://api.example.com/v1', adapter: 'generic',
    thinking: 'disabled', timeoutSeconds: 300, contextWindow: 8192, maxOutputTokens: 1024, tokenParameter: 'max_tokens'
  },
  createdAt: new Date().toISOString(), status: 'complete', text: '审稿结果', error: '', finishReason: 'stop',
  contextHash: 'b'.repeat(64), context: '', sourceText: '正文',
  ...extra
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-batch-rm-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials')); await workspace.initialize();
  const parent = path.join(root, 'books'); await fs.mkdir(parent);
  const project = await workspace.createProject(parent, '多模型审稿');
  const library = new LibraryStore(id => workspace.getProject(id), path.join(root, 'materials'));
  const characters = new CharacterStore(id => workspace.getProject(id), path.join(root, 'materials'));
  const service = new AIService(path.join(root, 'state'), {} as unknown as AIConnections, workspace, library, characters);
  const folder = path.join(root, 'state', 'ai-tasks', project.project.id);
  await fs.mkdir(folder, { recursive: true });
  const decisions = path.join(root, 'state', 'review-decisions', project.project.id);
  await fs.mkdir(decisions, { recursive: true });
  return { root, project, service, folder, decisions };
}

test('批量删除多模型审稿：两条记录与处理记录一起消失，其余任务保留', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const a = crypto.randomUUID(), b = crypto.randomUUID(), keep = crypto.randomUUID();
  for (const [id, text] of [[a, '模型A'], [b, '模型B'], [keep, '模型C']] as const) {
    await fs.writeFile(path.join(f.folder, `${id}.json`), JSON.stringify(task(id, f.project.project.id, { text })), 'utf8');
    if (id !== keep) await fs.writeFile(path.join(f.decisions, `${id}.json`), JSON.stringify({ schemaVersion: 1, projectId: f.project.project.id, taskId: id, reportFingerprint: 'c'.repeat(64), items: [] }), 'utf8');
  }
  await f.service.removeTasks(f.project.project.id, [a, b]);
  const left = await f.service.list(f.project.project.id);
  assert.deepEqual(left.map(item => item.id), [keep]);
  assert.equal(await fs.stat(path.join(f.decisions, `${a}.json`)).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(path.join(f.decisions, `${b}.json`)).then(() => true).catch(() => false), false);
});

test('批量删除多模型审稿：任一被引用/不存在/重复时整体拒绝，不部分删除', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const a = crypto.randomUUID(), b = crypto.randomUUID(), revise = crypto.randomUUID();
  for (const id of [a, b]) await fs.writeFile(path.join(f.folder, `${id}.json`), JSON.stringify(task(id, f.project.project.id)), 'utf8');
  await fs.writeFile(path.join(f.folder, `${revise}.json`), JSON.stringify(task(revise, f.project.project.id, { mode: 'revise', reviewTaskId: b, reviseIssueIds: ['issue-1'] })), 'utf8');
  await assert.rejects(f.service.removeTasks(f.project.project.id, [a, b]), /引用/u);
  assert.equal((await f.service.list(f.project.project.id)).length, 3, '被拒时一条都不能删');
  await assert.rejects(f.service.removeTasks(f.project.project.id, [a, a]), /重复/u);
  await assert.rejects(f.service.removeTasks(f.project.project.id, [a, crypto.randomUUID()]), /不存在/u);
  assert.equal((await f.service.list(f.project.project.id)).length, 3);
});
