import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { CharacterStore } from '../src/main/characters';
import { WorldInfoStore } from '../src/main/world-info';
import { SettingImportService } from '../src/main/setting-import';

const text = [
  '角色：林夏',
  '别名：夏夏',
  '外貌：短发，总穿旧外套。',
  '性格：嘴硬心软。',
  '',
  '地点：雾港',
  '正文：终年大雾的海港城。',
  '关键词：雾港,码头'
].join('\n');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-setting-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials')); await workspace.initialize();
  const parent = path.join(root, 'books'); await fs.mkdir(parent);
  const project = await workspace.createProject(parent, '设定书');
  const characters = new CharacterStore(id => workspace.getProject(id), path.join(root, 'materials'));
  const world = new WorldInfoStore(workspace);
  const service = new SettingImportService(characters, world);
  return { root, workspace, project, characters, world, service };
}

test('设定导入：预览只产生草稿，确认后才写入人物卡与世界书', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const preview = f.service.preview(f.project.project.id, text);
  assert.equal(preview.candidates.length, 2);
  assert.deepEqual((await f.characters.read(f.project.project.id)).value.cards, [], '预览阶段不能写人物卡');
  assert.deepEqual(await f.world.list(f.project.project.id), [], '预览阶段不能写世界书');
  const result = await f.service.confirm(f.project.project.id, preview.token, preview.candidates.map(candidate => ({ id: candidate.id })));
  assert.deepEqual(result.characters, ['林夏']);
  const saved = await f.characters.read(f.project.project.id);
  assert.equal(saved.value.cards.length, 1);
  assert.equal(saved.value.cards[0]!.name, '林夏');
  assert.match(saved.value.cards[0]!.creatorNotes, /别名：夏夏/u);
  assert.ok(result.world && result.world.entries === 1, '应生成一本世界书');
  const books = await f.world.list(f.project.project.id);
  assert.equal(books.length, 1);
  const book = await f.world.read(f.project.project.id, books[0]!.name);
  assert.ok(JSON.stringify(book).includes('雾港'));
});

test('设定导入：同名人物卡可选合并，合并后内容追加；令牌一次性', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const first = f.service.preview(f.project.project.id, text);
  await f.service.confirm(f.project.project.id, first.token, first.candidates.filter(item => item.kind === 'character').map(item => ({ id: item.id })));
  const before = await f.characters.read(f.project.project.id);
  const again = f.service.preview(f.project.project.id, '角色：林夏\n性格：其实很怕黑。');
  const merged = await f.service.confirm(f.project.project.id, again.token, [{ id: again.candidates[0]!.id, mode: 'merge' }]);
  assert.deepEqual(merged.characters, ['林夏']);
  const after = await f.characters.read(f.project.project.id);
  assert.equal(after.value.cards.length, 1, '合并不能新增卡片');
  assert.match(after.value.cards[0]!.personality, /其实很怕黑/u);
  await assert.rejects(f.service.confirm(f.project.project.id, first.token, [{ id: 'candidate-1' }]), /已失效/u);
});

test('设定导入：没有候选、候选与选择不匹配、跨书令牌都拒绝', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  assert.throws(() => f.service.preview(f.project.project.id, '没有标题的普通文字'), /没有识别到候选/u);
  const preview = f.service.preview(f.project.project.id, text);
  await assert.rejects(f.service.confirm(f.project.project.id, preview.token, [{ id: 'candidate-99' }]), /不匹配/u);
  const other = await f.workspace.createProject(path.dirname(f.project.root), '别的书');
  await assert.rejects(f.service.confirm(other.project.id, preview.token, [{ id: 'candidate-1' }]), /已失效/u);
});
