import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { CharacterStore } from '../src/main/characters';
import { CharacterLibrary } from '../src/main/character-library';
import { parseCard } from '../src/core/st-cards';
import { readCardJson } from '../src/core/png-text';
import type { CharacterEdit } from '../src/shared/contracts';

const fields = (name: string, extra: Partial<CharacterEdit['fields']> = {}) => ({
  name, description: '', personality: '', scenario: '', firstMessage: '', examples: '', creatorNotes: '', systemPrompt: '', postHistoryInstructions: '', alternateGreetings: [], ...extra
});
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-cardlib-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials'));
  await workspace.initialize();
  const book = path.join(root, '甲'); await fs.mkdir(book);
  const project = await workspace.attach(book);
  const store = new CharacterStore(id => workspace.getProject(id), path.join(root, 'materials'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const add = async (name: string, extra: Partial<CharacterEdit['fields']> = {}) => {
    const snapshot = await store.save(project.id, { fields: fields(name, extra), enabled: true }, (await store.read(project.id)).hash);
    return snapshot.value.cards.find(card => card.name === name)!;
  };
  return { root, project, store, library: new CharacterLibrary(store), add };
}

test('角色卡导出：写出可被 SillyTavern 读取的 PNG，并落在本书资料目录', async t => {
  const f = await fixture(t);
  const card = await f.add('林夏', { description: '雨夜的旅人' });
  const result = await f.library.exportPng(f.project.id, card.id);
  assert.equal(result.specVersion, 3);
  assert.equal(result.name, '林夏');
  const file = path.join(f.root, 'materials', f.project.id, result.relative);
  const bytes = await fs.readFile(file);
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  assert.equal(parseCard(readCardJson(new Uint8Array(bytes))).data.description, '雨夜的旅人');
});

test('删除角色：先备份再移除，原件仍留在备份里', async t => {
  const f = await fixture(t);
  const keep = await f.add('林夏');
  await f.add('阿岚', { description: '剑客' });
  const snapshot = await f.store.read(f.project.id);
  const result = await f.library.remove(f.project.id, keep.id, snapshot.hash);
  assert.equal(result.removed, '林夏');
  assert.deepEqual(result.snapshot.value.cards.map(card => card.name), ['阿岚']);
  assert.ok(result.backup.includes('角色卡备份'), `备份路径应落在 角色卡备份：${result.backup}`);
  const backup = JSON.parse(await fs.readFile(path.join(f.root, 'materials', f.project.id, result.backup), 'utf8')) as { cards: { name: string }[] };
  assert.deepEqual(backup.cards.map(card => card.name).sort(), ['林夏', '阿岚'].sort(), '备份里应保留被删角色的原始内容');
});

test('合并角色：保留一张、补齐空字段并合并问候语，被合并的一张也进备份', async t => {
  const f = await fixture(t);
  const keep = await f.add('林夏', { description: '雨夜的旅人' });
  const drop = await f.add('林夏（旧稿）', { personality: '寡言', alternateGreetings: ['雨很大。'] });
  const snapshot = await f.store.read(f.project.id);
  const result = await f.library.merge(f.project.id, keep.id, drop.id, snapshot.hash);
  assert.equal(result.mergedInto, '林夏');
  assert.equal(result.dropped, '林夏（旧稿）');
  const merged = result.snapshot.value.cards.find(card => card.id === keep.id)!;
  assert.equal(merged.name, '林夏');
  assert.equal(merged.description, '雨夜的旅人', '已有字段不被覆盖');
  assert.equal(merged.personality, '寡言', '空字段应从被合并卡片补齐');
  assert.deepEqual(merged.alternateGreetings, ['雨很大。']);
  assert.equal(result.snapshot.value.cards.length, 1);
  const backup = JSON.parse(await fs.readFile(path.join(f.root, 'materials', f.project.id, result.backup), 'utf8')) as { cards: unknown[] };
  assert.equal(backup.cards.length, 2, '合并前的两张都要留在备份里');
});

test('角色卡操作：hash 变化与非法合并都被拒绝', async t => {
  const f = await fixture(t);
  const card = await f.add('林夏');
  await assert.rejects(f.library.remove(f.project.id, card.id, 'deadbeef'), /已在外部更新/u);
  const snapshot = await f.store.read(f.project.id);
  await assert.rejects(f.library.merge(f.project.id, card.id, card.id, snapshot.hash), /不能把角色合并到自己/u);
});
