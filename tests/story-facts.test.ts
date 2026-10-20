import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/main/workspace';
import { StoryMemoryStore } from '../src/main/story-memory';
import { materialDirectory } from '../src/main/markdown-materials';
import { textDocument } from '../src/main/text-import';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-facts-')), local = path.join(root, 'local'), materials = path.join(root, 'materials');
  const workspace = new Workspace(local, materials); await workspace.initialize();
  await Promise.all(['甲', '乙'].map(name => fs.mkdir(path.join(root, name))));
  const a = await workspace.attach(path.join(root, '甲')), b = await workspace.attach(path.join(root, '乙'));
  const memory = new StoryMemoryStore(workspace, materials);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { workspace, memory, a, b, materials };
}

test('事实与伏笔：手工录入、启用/停用、解决状态、来源版本与删除', async t => {
  const { workspace, memory, a, materials } = await fixture(t);
  const chapter = await workspace.createChapter(a.id, textDocument('月钥只能开启北门。'));
  const empty = await memory.read(a.id);
  assert.deepEqual(empty.value.facts, []);

  const withFact = await memory.saveFact(a.id, { kind: 'fact', text: '月钥只能开启北门' }, empty.hash);
  assert.equal(withFact.value.facts.length, 1); assert.equal(withFact.value.facts[0].enabled, true);
  const withForeshadow = await memory.saveFact(a.id, { kind: 'foreshadow', text: '北门外的脚步声是谁', sourcePath: chapter.path, sourceHash: chapter.hash }, withFact.hash);
  assert.equal(withForeshadow.value.facts.length, 2);
  assert.equal(withForeshadow.value.facts[1].state, 'open');
  assert.equal(withForeshadow.value.facts[1].sourcePath, chapter.path);

  const fact = withForeshadow.value.facts[1];
  const resolved = await memory.saveFact(a.id, { id: fact.id, kind: fact.kind, text: fact.text, state: 'resolved', enabled: false }, withForeshadow.hash);
  assert.equal(resolved.value.facts[1].state, 'resolved'); assert.equal(resolved.value.facts[1].enabled, false);
  await assert.rejects(memory.saveFact(a.id, { id: '11111111-1111-4111-8111-111111111111', kind: 'fact', text: '不存在的条目' }, resolved.hash), /未找到这条事实/u);
  await assert.rejects(memory.saveFact(a.id, { kind: 'fact', text: 'x' }, withForeshadow.hash), /已更新，请重新读取/u);

  // The whole story memory file is the single source of truth, and facts survive a re-read.
  const file = path.join(await materialDirectory(materials, a.id), '故事记忆.md');
  assert.match(await fs.readFile(file, 'utf8'), /北门外的脚步声/u);
  const reread = await memory.read(a.id);
  assert.equal(reread.value.facts.length, 2); assert.equal(reread.value.facts[1].state, 'resolved');

  const removed = await memory.removeFact(a.id, fact.id, reread.hash);
  assert.equal(removed.value.facts.length, 1);
  await assert.rejects(memory.removeFact(a.id, fact.id, removed.hash), /未找到这条事实/u);
});

test('事实与伏笔：拒绝跨书、错来源版本与不成对的来源字段', async t => {
  const { workspace, memory, a, b } = await fixture(t);
  const chapter = await workspace.createChapter(a.id, textDocument('甲书正文。'));
  const other = await workspace.createChapter(b.id, textDocument('乙书正文。'));
  const start = await memory.read(a.id);
  await assert.rejects(memory.saveFact(a.id, { kind: 'fact', text: '跨书来源', sourcePath: other.path, sourceHash: other.hash }, start.hash));
  await assert.rejects(memory.saveFact(a.id, { kind: 'fact', text: '版本不符', sourcePath: chapter.path, sourceHash: 'f'.repeat(64) }, start.hash), /已变化/u);
  await assert.rejects(memory.saveFact(a.id, { kind: 'fact', text: '只有路径', sourcePath: chapter.path }, start.hash), /必须同时提供路径与版本|来源/u);
  assert.equal((await memory.read(a.id)).value.facts.length, 0);
});

test('事实与伏笔：进入上下文时排在摘要之前并受预算限制', async t => {
  const { memory, a } = await fixture(t);
  const first = await memory.saveFact(a.id, { kind: 'fact', text: '主角右手有旧伤' }, (await memory.read(a.id)).hash);
  await memory.saveFact(a.id, { kind: 'foreshadow', text: '未解决：谁拿走了月钥' }, first.hash);
  const context = await memory.context(a.id);
  assert.match(context, /作者确认事实：主角右手有旧伤/u);
  assert.match(context, /未解决伏笔：未解决：谁拿走了月钥/u);
  assert.ok(context.indexOf('作者确认事实') < context.indexOf('未解决伏笔'));

  // A disabled fact disappears from the context without being deleted.
  const snapshot = await memory.read(a.id);
  const target = snapshot.value.facts[0];
  const disabled = await memory.saveFact(a.id, { id: target.id, kind: target.kind, text: target.text, enabled: false }, snapshot.hash);
  assert.equal(disabled.value.facts.length, 2);
  assert.doesNotMatch(await memory.context(a.id), /主角右手有旧伤/u);
});

test('事实与伏笔：旧版故事记忆没有 facts 字段时按空列表读取，损坏格式仍保留原文件', async t => {
  const { workspace, memory, a, materials } = await fixture(t);
  const folder = await materialDirectory(materials, a.id);
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, '故事记忆.md');
  await fs.writeFile(file, `<!-- novel-writer ${JSON.stringify({ kind: 'memory', schemaVersion: 1, projectId: a.id, budgetBytes: 6000, entries: [] })} -->\n# 故事记忆\n`);
  const legacy = await memory.read(a.id);
  assert.deepEqual(legacy.value.facts, []);
  await fs.writeFile(file, '{not markdown');
  await assert.rejects(memory.read(a.id));
  assert.equal(await fs.readFile(file, 'utf8'), '{not markdown');
  assert.ok(workspace.getProject(a.id));
});
