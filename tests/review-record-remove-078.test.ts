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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-review-rm-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials')); await workspace.initialize();
  const parent = path.join(root, 'books'); await fs.mkdir(parent);
  const project = await workspace.createProject(parent, '审稿书');
  const library = new LibraryStore(id => workspace.getProject(id), path.join(root, 'materials'));
  const characters = new CharacterStore(id => workspace.getProject(id), path.join(root, 'materials'));
  const service = new AIService(path.join(root, 'state'), {} as unknown as AIConnections, workspace, library, characters);
  const folder = path.join(root, 'state', 'ai-tasks', project.project.id);
  await fs.mkdir(folder, { recursive: true });
  const decisions = path.join(root, 'state', 'review-decisions', project.project.id);
  await fs.mkdir(decisions, { recursive: true });
  return { root, project, service, folder, decisions };
}

test('删除审稿记录：任务与处理记录一起消失', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const id = crypto.randomUUID();
  await fs.writeFile(path.join(f.folder, `${id}.json`), JSON.stringify(task(id, f.project.project.id)), 'utf8');
  const record = path.join(f.decisions, `${id}.json`);
  await fs.writeFile(record, JSON.stringify({ schemaVersion: 1, projectId: f.project.project.id, taskId: id, reportFingerprint: 'c'.repeat(64), items: [] }), 'utf8');
  await f.service.removeTask(f.project.project.id, id);
  assert.deepEqual(await f.service.list(f.project.project.id), []);
  assert.equal(await fs.stat(record).then(() => true).catch(() => false), false, '处理记录应被删除');
});

test('删除审稿记录：仍被修订任务引用时拒绝，且处理记录不丢', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const reviewId = crypto.randomUUID(), reviseId = crypto.randomUUID();
  await fs.writeFile(path.join(f.folder, `${reviewId}.json`), JSON.stringify(task(reviewId, f.project.project.id)), 'utf8');
  await fs.writeFile(path.join(f.folder, `${reviseId}.json`), JSON.stringify(task(reviseId, f.project.project.id, { mode: 'revise', reviewTaskId: reviewId, reviseIssueIds: ['issue-1'] })), 'utf8');
  const record = path.join(f.decisions, `${reviewId}.json`);
  await fs.writeFile(record, JSON.stringify({ schemaVersion: 1, projectId: f.project.project.id, taskId: reviewId, reportFingerprint: 'c'.repeat(64), items: [] }), 'utf8');
  await assert.rejects(f.service.removeTask(f.project.project.id, reviewId), /引用/u);
  assert.equal(await fs.stat(record).then(() => true).catch(() => false), true, '被引用时不能删处理记录');
  await f.service.removeTask(f.project.project.id, reviseId);
  await f.service.removeTask(f.project.project.id, reviewId);
  assert.equal(await fs.stat(record).then(() => true).catch(() => false), false);
});

test('删除审稿记录：处理记录缺失或类型异常时的行为明确', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const id = crypto.randomUUID();
  await fs.writeFile(path.join(f.folder, `${id}.json`), JSON.stringify(task(id, f.project.project.id)), 'utf8');
  await f.service.removeTask(f.project.project.id, id);
  assert.deepEqual(await f.service.list(f.project.project.id), [], '没有处理记录也能正常删除任务');
  const bad = crypto.randomUUID();
  await fs.writeFile(path.join(f.folder, `${bad}.json`), JSON.stringify(task(bad, f.project.project.id)), 'utf8');
  const linkTarget = path.join(f.root, 'outside.json'); await fs.writeFile(linkTarget, '{}', 'utf8');
  await fs.symlink(linkTarget, path.join(f.decisions, `${bad}.json`)).catch(() => null);
  const linked = await fs.lstat(path.join(f.decisions, `${bad}.json`)).then(stat => stat.isSymbolicLink()).catch(() => false);
  if (linked) {
    await assert.rejects(f.service.removeTask(f.project.project.id, bad), /类型异常/u);
    assert.equal((await f.service.list(f.project.project.id)).length, 1, '拒绝时任务记录应保留');
  }
});
