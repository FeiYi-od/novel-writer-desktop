import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { RelationStore } from '../src/main/relations';
import type { Relation } from '../src/core/relations';

const rel = (from: string, to: string, label: string, strength = 3): Relation => ({ id: '', from, to, label, note: '', mutual: false, strength });
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-relations-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials'));
  await workspace.initialize();
  const book = path.join(root, '甲'); await fs.mkdir(book);
  const project = await workspace.attach(book);
  const store = new RelationStore(workspace);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, project, store };
}

test('人物关系存储：保存后读回，分组包含两端，id 自动补齐', async t => {
  const f = await fixture(t);
  const empty = await f.store.read(f.project.id);
  assert.deepEqual(empty.relations, []);
  const saved = await f.store.save(f.project.id, [rel('林夏', '阿岚', '师徒', 5)], empty.hash);
  assert.ok(saved.relations[0].id.length === 36);
  assert.deepEqual(saved.groups.map(group => group.name), ['阿岚', '林夏']);
  const reloaded = await f.store.read(f.project.id);
  assert.deepEqual(reloaded.relations.map(item => item.label), ['师徒']);
  assert.equal(reloaded.hash, saved.hash);
});

test('人物关系存储：并发修改与重复关系都被拒绝，成功覆盖时留历史', async t => {
  const f = await fixture(t);
  const first = await f.store.save(f.project.id, [rel('林夏', '阿岚', '师徒')], '');
  await assert.rejects(f.store.save(f.project.id, [rel('林夏', '阿岚', '宿敌')], 'deadbeef'), /已被其他窗口修改/u);
  await assert.rejects(f.store.save(f.project.id, [rel('林夏', '阿岚', '师徒'), rel('阿岚', '林夏', '师徒')], first.hash), /重复/u);
  const second = await f.store.save(f.project.id, [rel('林夏', '阿岚', '师徒'), rel('林夏', '沈舟', '旧识')], first.hash);
  assert.equal(second.relations.length, 2);
  const history = await fs.readdir(path.join(f.project.root, '小说资料', '人物关系历史')).catch(() => [] as string[]);
  assert.ok(history.length >= 1, '覆盖保存应留下历史版本');
});
