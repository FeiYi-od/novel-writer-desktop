import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workspace } from '../src/main/workspace';
import { LibraryStore } from '../src/main/library';
import { CharacterStore } from '../src/main/characters';
import { PlanningStore } from '../src/main/planning';
import { KnowledgeService } from '../src/main/knowledge-service';
import { textDocument } from '../src/main/text-import';
import type { KnowledgeSearchRequest } from '../src/shared/contracts';

async function fixture(t: TestContext, rerank?: (connectionId: string) => { order: (query: string, texts: string[], signal: AbortSignal) => Promise<{ ranking: { index: number; score: number }[]; warning?: string }> }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-krerank-'));
  const materials = path.join(root, 'materials');
  const workspace = new Workspace(path.join(root, 'local'), materials); await workspace.initialize();
  await fs.mkdir(path.join(root, '甲')); const a = await workspace.attach(path.join(root, '甲'));
  const library = new LibraryStore(id => workspace.getProject(id), materials);
  const characters = new CharacterStore(id => workspace.getProject(id), materials);
  const planning = new PlanningStore(id => workspace.getProject(id), materials);
  await library.read(a.id); await characters.read(a.id); await planning.read(a.id);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const service = new KnowledgeService(workspace, library, characters, planning, undefined, undefined, rerank);
  await workspace.createChapter(a.id, textDocument('月钥开启北门。'));
  await workspace.createChapter(a.id, textDocument('雨声落在月门。'));
  const request = (rerankOn?: boolean): KnowledgeSearchRequest => ({ projectId: a.id, requestId: randomUUID(), corpus: 'discussion', query: '月', topK: 10, ...(rerankOn ? { rerank: { connectionId: randomUUID() } } : {}) });
  return { service, a, request };
}

test('可选重排：开启后按外部分数改变顺序，未开启时不动', async t => {
  const f = await fixture(t, () => ({ order: async (_query, texts) => ({ ranking: texts.map((_, index) => ({ index, score: index })) }) }));
  const baseline = await f.service.search(f.request());
  assert.ok(baseline.hits.length >= 2, '需要至少两段命中才能验证顺序');
  const reranked = await f.service.search(f.request(true));
  assert.equal(reranked.hits.length, baseline.hits.length, '重排不能增删命中');
  assert.deepEqual(reranked.hits.map(hit => hit.id).slice().reverse(), baseline.hits.map(hit => hit.id));
});

test('可选重排：重排失败时保持原顺序并写警告，不阻断检索', async t => {
  const f = await fixture(t, () => ({ order: async () => { throw new Error('重排服务不可用'); } }));
  const baseline = await f.service.search(f.request());
  const failed = await f.service.search(f.request(true));
  assert.deepEqual(failed.hits.map(hit => hit.id), baseline.hits.map(hit => hit.id));
  assert.match(failed.warnings.join('\n'), /重排失败/u);
  assert.equal(failed.usedMode, 'keyword');
});
