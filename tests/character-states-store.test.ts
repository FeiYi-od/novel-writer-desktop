import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { CharacterStateStore } from '../src/main/character-states';
import type { CharacterState } from '../src/core/character-states';

const state = (character: string, label: string, extra: Partial<CharacterState> = {}): CharacterState => ({ id: '', character, label, note: '', ...extra });
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-cstates-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials'));
  await workspace.initialize();
  const book = path.join(root, '甲'); await fs.mkdir(book);
  const project = await workspace.attach(book);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, project, store: new CharacterStateStore(workspace) };
}

test('人物状态存储：保存读回、id 补齐与并发/重复拒绝', async t => {
  const f = await fixture(t);
  const empty = await f.store.read(f.project.id);
  assert.deepEqual(empty.states, []);
  const saved = await f.store.save(f.project.id, [state('林夏', '受伤', { fromChapter: 3, toChapter: 5 })], empty.hash);
  assert.equal(saved.states[0].id.length, 36);
  const reloaded = await f.store.read(f.project.id);
  assert.deepEqual(reloaded.states.map(item => [item.character, item.label, item.fromChapter, item.toChapter]), [['林夏', '受伤', 3, 5]]);
  assert.equal(reloaded.hash, saved.hash);
  await assert.rejects(f.store.save(f.project.id, [state('林夏', '失忆')], 'deadbeef'), /已被其他窗口修改/u);
  await assert.rejects(f.store.save(f.project.id, [state('林夏', '受伤'), state('林夏', '受伤')], saved.hash), /重复/u);
});

test('人物状态存储：覆盖保存留下历史版本', async t => {
  const f = await fixture(t);
  const first = await f.store.save(f.project.id, [state('林夏', '受伤')], '');
  await f.store.save(f.project.id, [state('林夏', '康复')], first.hash);
  const history = await fs.readdir(path.join(f.project.root, '小说资料', '人物状态历史')).catch(() => [] as string[]);
  assert.ok(history.length >= 1);
});
