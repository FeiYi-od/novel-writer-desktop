import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { PromptLibraryStore } from '../src/main/prompt-library';
import { normalizeTemplate } from '../src/core/prompt-library';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-prompts-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials'));
  await workspace.initialize();
  const book = path.join(root, '甲'); await fs.mkdir(book);
  const project = await workspace.attach(book);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, project, store: new PromptLibraryStore(workspace) };
}
const tpl = (name: string, body: string) => normalizeTemplate({ name, body, kind: 'write' });

test('提示词库：新建保存读回，改动同一模板会升版并保留旧内容', async t => {
  const f = await fixture(t);
  const empty = await f.store.read(f.project.id);
  assert.deepEqual(empty.templates, []);
  const first = await f.store.save(f.project.id, [tpl('续写雨夜', '按当前章节续写。')], empty.hash);
  assert.equal(first.templates[0].version, 1);
  const id = first.templates[0].id;
  const edited = await f.store.save(f.project.id, [{ ...first.templates[0], body: '按当前章节续写，保持冷色描写。' }], first.hash);
  assert.equal(edited.templates[0].version, 2);
  assert.equal(edited.templates[0].versions[0].body, '按当前章节续写。');
  const reloaded = await f.store.read(f.project.id);
  assert.equal(reloaded.templates[0].body, '按当前章节续写，保持冷色描写。');
  assert.equal(reloaded.templates[0].id, id, '同一模板应保持 id');
  assert.equal(reloaded.hash, edited.hash);
});

test('提示词库：并发修改与重名被拒绝，覆盖保存留历史', async t => {
  const f = await fixture(t);
  const first = await f.store.save(f.project.id, [tpl('续写', 'x')], '');
  await assert.rejects(f.store.save(f.project.id, [tpl('续写', 'y')], 'deadbeef'), /已被其他窗口修改/u);
  await assert.rejects(f.store.save(f.project.id, [tpl('续写', 'x'), tpl(' 续写 ', 'y')], first.hash), /重复/u);
  await f.store.save(f.project.id, [tpl('续写', '新的')], first.hash);
  const history = await fs.readdir(path.join(f.root, '创作资料', '提示词库历史')).catch(() => [] as string[]);
  assert.ok(history.length >= 1);
});
