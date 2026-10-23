import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { StyleHistoryStore } from '../src/main/style-history';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-stylehist-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials'));
  await workspace.initialize();
  const book = path.join(root, '甲'); await fs.mkdir(book);
  const project = await workspace.attach(book);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, project, store: new StyleHistoryStore(workspace) };
}

test('文风版本存储：建档、改规则升版、记录效果', async t => {
  const f = await fixture(t);
  const empty = await f.store.read(f.project.id);
  const created = await f.store.ensure(f.project.id, empty.hash, 's1', '短句为主。');
  assert.equal(created.entries[0].current.version, 1);
  assert.equal((await f.store.ensure(f.project.id, created.hash, 's1', '短句为主。')).entries.length, 1, '重复建档不应新增');
  const revised = await f.store.revise(f.project.id, created.hash, 's1', '短句为主，少形容词。');
  assert.equal(revised.entries[0].current.version, 2);
  assert.equal(revised.entries[0].history[0].rules, '短句为主。');
  const effected = await f.store.record(f.project.id, revised.hash, 's1', { source: 'trial', characters: 600, averageSentence: 7, dialogueRatio: 0.4 });
  assert.equal(effected.entries[0].effects.length, 1);
  const restored = await f.store.restore(f.project.id, effected.hash, 's1', 1);
  assert.equal(restored.entries[0].current.rules, '短句为主。');
  assert.equal(restored.entries[0].current.version, 3, '恢复也记为新版本');
});

test('文风版本存储：并发修改被拒绝，覆盖前留历史文件', async t => {
  const f = await fixture(t);
  const created = await f.store.ensure(f.project.id, '', 's1', '规则甲。');
  await assert.rejects(f.store.revise(f.project.id, 'deadbeef', 's1', '规则乙。'), /已被其他窗口修改/u);
  await f.store.revise(f.project.id, created.hash, 's1', '规则乙。');
  const history = await fs.readdir(path.join(f.project.root, '小说资料', '文风版本历史')).catch(() => [] as string[]);
  assert.ok(history.length >= 1, '覆盖保存应留下历史版本');
});
