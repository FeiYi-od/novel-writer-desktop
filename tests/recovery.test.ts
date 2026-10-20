import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workspace } from '../src/main/workspace';
import { RecoveryStore } from '../src/main/recovery';
import { textDocument } from '../src/main/text-import';
import { copyableText } from '../src/core/typography';
async function setup() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-recovery-')); const data = path.join(root, 'data'); const workspace = new Workspace(data); await workspace.initialize(); await fs.mkdir(path.join(root, 'A')); await fs.mkdir(path.join(root, 'B')); const a = await workspace.attach(path.join(root, 'A')), b = await workspace.attach(path.join(root, 'B')); const recovery = new RecoveryStore(path.join(data, 'recovery-checkpoints'), workspace); return { root, data, workspace, a, b, recovery }; }
test('本机恢复：版本单调、保存标记不清除新编辑、跨书与来源路径保护', async t => {
  const f = await setup(); t.after(() => fs.rm(f.root, { recursive: true, force: true })); const doc = await f.workspace.createChapter(f.a.id); const id = randomUUID();
  const request = { id, revision: 1, projectId: f.a.id, path: doc.path, expectedHash: doc.hash, content: textDocument('初始草稿') };
  await f.recovery.checkpoint(request); await f.recovery.checkpoint({ ...request, revision: 2, content: textDocument('最新草稿') }); await f.recovery.checkpoint(request); await f.recovery.complete(f.a.id, id, 1);
  let draft = await f.recovery.read(f.a.id, id); assert.equal(copyableText(draft.content), '　　最新草稿'); assert.equal(draft.status, 'pending'); assert.equal(draft.revision, 2);
  await f.recovery.complete(f.a.id, id, 2); draft = await f.recovery.read(f.a.id, id); assert.equal(draft.status, 'saved');
  await f.recovery.checkpoint({ ...request, revision: 3, content: textDocument('下一批编辑') }); assert.equal((await f.recovery.read(f.a.id, id)).status, 'pending');
  assert.equal((await f.recovery.list(f.b.id)).length, 0); await assert.rejects(f.recovery.read(f.b.id, id), /ENOENT/);
  await assert.rejects(f.recovery.checkpoint({ ...request, revision: 4, path: '../escape.docx' }), /路径/);
  await assert.rejects(f.recovery.checkpoint({ ...request, revision: 4, path: '小说资料/hide.docx' }), /路径/);
  const other = await f.workspace.createChapter(f.a.id); await assert.rejects(f.recovery.checkpoint({ ...request, revision: 4, path: other.path }), /目标/);
});
test('恢复副本保留原稿与排版，外部冲突和删除原稿仍可保留草稿，未知版本拒绝', async t => {
  const f = await setup(); t.after(() => fs.rm(f.root, { recursive: true, force: true })); const doc = await f.workspace.createChapter(f.a.id, textDocument('原稿')); const bytes = await fs.readFile(path.join(f.a.root, doc.path));
  const id = randomUUID(), content = { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '第一章' }] }, { type: 'paragraph', content: [{ type: 'text', text: '带样式的恢复草稿', marks: [{ type: 'bold' }] }] }] };
  await f.recovery.checkpoint({ projectId: f.a.id, path: doc.path, expectedHash: doc.hash, content, id, revision: 1 });
  const restored = await f.workspace.createChapter(f.a.id, (await f.recovery.read(f.a.id, id)).content); assert.notEqual(restored.path, doc.path); assert.match(restored.path, /\.docx$/); assert.deepEqual(await fs.readFile(path.join(f.a.root, doc.path)), bytes);
  if (typeof restored.content !== 'string') { assert.equal(restored.content.content?.[0].type, 'heading'); assert.deepEqual(restored.content.content?.[1].content?.[0].marks, [{ type: 'bold' }]); assert.match(copyableText(restored.content), /　　带样式/); }
  await fs.writeFile(path.join(f.a.root, doc.path), '外部改动'); await assert.rejects(f.workspace.saveChapter({ projectId: f.a.id, path: doc.path, expectedHash: doc.hash, content }), /其他程序/); assert.equal(await fs.readFile(path.join(f.a.root, doc.path), 'utf8'), '外部改动');
  await fs.unlink(path.join(f.a.root, doc.path)); await f.recovery.checkpoint({ projectId: f.a.id, path: doc.path, expectedHash: doc.hash, content, id, revision: 2 }); assert.equal((await f.recovery.list(f.a.id)).length, 1);
  const file = path.join(f.data, 'recovery-checkpoints', f.a.id, `${id}.json`); const future = (await fs.readFile(file, 'utf8')).replace('"schemaVersion":1', '"schemaVersion":99'); await fs.writeFile(file, future);
  await assert.rejects(f.recovery.read(f.a.id, id)); assert.equal(await fs.readFile(file, 'utf8'), future);
});
