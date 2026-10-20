import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { MacroStore } from '../src/main/macros';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-macros-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials'));
  await workspace.initialize();
  const book = path.join(root, '甲'); await fs.mkdir(book);
  const project = await workspace.attach(book);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, project, store: new MacroStore(workspace) };
}

test('正则脚本：导入 SillyTavern 导出格式并在预览时套用', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.store.read(f.project.id), []);
  const imported = await f.store.import(f.project.id, [
    { findRegex: '\\((.*?)\\)', replaceString: '（$1）', trimStrings: ['~~'] },
    { findRegex: '嗯', replaceString: '唔', disabled: true }
  ]);
  assert.equal(imported.length, 2);
  const preview = await f.store.preview(f.project.id, '{{char}}说(小声)嗯~~', { characterName: '林夏' });
  assert.equal(preview.expanded, '林夏说(小声)嗯~~', '宏先展开');
  assert.equal(preview.applied, '林夏说（小声）嗯', '再套正则，禁用的那条不生效');
  assert.deepEqual(await f.store.read(f.project.id), imported, '读回应与写入一致');
});

test('正则脚本：非法输入被拒绝，缺 findRegex 指明第几条', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.import(f.project.id, { foo: 1 }), /应为数组/u);
  await assert.rejects(f.store.import(f.project.id, [{ replaceString: 'x' }]), /第 1 条/u);
  await assert.rejects(f.store.import(f.project.id, []), /没有正则脚本/u);
});

test('宏预览：lastMessage 与 user 可用，未知宏保留', async t => {
  const f = await fixture(t);
  const preview = await f.store.preview(f.project.id, '{{user}}看到：{{lastMessage}}｜{{unknown}}', { userName: '作者甲', lastMessage: '你来了。' });
  assert.equal(preview.expanded, '作者甲看到：你来了。｜{{unknown}}');
  assert.equal(preview.applied, preview.expanded, '没有脚本时不改动文本');
});
