import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Workspace } from '../src/main/workspace';
import { backupBook, restoreBackup, verifyBackup, isSafeRelative, safeName } from '../src/main/nas-backup';
import { listRawDrafts, restoreRawDraft, listPreviousVersions, restorePreviousVersion } from '../src/main/recovery';
import { rewriteDocxParagraphs, bodyParagraphTexts } from '../src/main/docx-fidelity';
import { LibraryStore } from '../src/main/library';
import { CharacterStore } from '../src/main/characters';
import { AIConnections } from '../src/main/ai-connections';
import { AIService } from '../src/main/ai-service';
import { textDocument } from '../src/main/text-import';
import JSZip from 'jszip';

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

async function book(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-audit-'));
  const local = path.join(root, 'local'), materials = path.join(root, 'materials');
  const workspace = new Workspace(local, materials); await workspace.initialize();
  const directory = path.join(root, '书'); await fs.mkdir(directory);
  const project = await workspace.attach(directory);
  const chapter = await workspace.createChapter(project.id, textDocument('　　第一章正文。'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, local, materials, workspace, project, chapter };
}

test('A01 备份包含固定资料目录：恢复后世界观资料仍在', async t => {
  const f = await book(t);
  f.workspace.materialsRoot;
  const current = await f.workspace.readNotes(f.project.id);
  const notes = await f.workspace.saveNotes(f.project.id, { ...current.value, world: '海上城邦，雨季长达半年。' }, current.hash);
  assert.ok(notes);
  const backup = await backupBook(f.workspace, f.project.id, path.join(f.root, '备份'), new Date('2026-10-20T00:00:00Z'));
  assert.ok(backup.materialsFiles > 0, `备份里应包含资料文件，实际 ${backup.materialsFiles}`);
  assert.ok(backup.entries.some(entry => entry.path.startsWith('materials/')), '清单里应有独立 materials/ 分区条目');
  const verified = await verifyBackup(backup.folder);
  assert.equal(verified.ok, true, JSON.stringify(verified));
  const restored = await restoreBackup(backup.folder, path.join(f.root, '恢复'), new Date('2026-10-20T01:00:00Z'));
  assert.ok(restored.materialsFolder, '恢复结果应给出资料目录');
  const noteFile = path.join(restored.materialsFolder!, '创作笔记.md');
  assert.match(await fs.readFile(noteFile, 'utf8'), /海上城邦/u, '恢复后应能读到世界观');
});

test('A02 清单路径越界：校验判失败、恢复拒绝，且不会写到目标目录外', async t => {
  const f = await book(t);
  const folder = path.join(f.root, '坏备份'); await fs.mkdir(folder);
  const payload = Buffer.from('escaped', 'utf8');
  await fs.writeFile(path.join(folder, 'inside.txt'), payload);
  await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, projectName: '../../escape-name', entries: [
      { path: 'inside.txt', bytes: payload.length, sha256: sha(payload) },
      { path: '../../escaped.txt', bytes: payload.length, sha256: sha(payload) }
    ]
  }), 'utf8');
  const verified = await verifyBackup(folder);
  assert.equal(verified.ok, false, '越界路径不能让校验通过');
  assert.ok(verified.invalid.length >= 1);
  await assert.rejects(restoreBackup(folder, path.join(f.root, '目标')), /校验失败/u);
  assert.equal(await fs.stat(path.join(f.root, 'escaped.txt')).then(() => true).catch(() => false), false, '不能写到目标外');
  assert.equal(isSafeRelative('../../x'), false);
  assert.equal(isSafeRelative('C:/x'), false);
  assert.equal(isSafeRelative('a/b.txt'), true);
  const sanitized = safeName('../../书');
  assert.ok(!/[/\\\\]/u.test(sanitized) && !sanitized.split('..').length.toString().startsWith('0'), '目录名不能带路径分隔符');
  assert.ok(sanitized.length > 0, '目录名不能为空');
});

test('A03 草稿/历史版本取回不信任 sidecar 路径', async t => {
  const f = await book(t);
  const root = path.join(f.local, 'recovery');
  const directory = path.join(root, f.project.id); await fs.mkdir(directory, { recursive: true });
  const id = '1792000000000-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-draft.docx';
  await fs.writeFile(path.join(directory, id), Buffer.from('fake', 'utf8'));
  await fs.writeFile(path.join(directory, id.replace('-draft.docx', '-draft.meta.json')), JSON.stringify({ sourcePath: '../escaped-raw.docx', at: '2026-10-20T00:00:00Z', bytes: 4 }), 'utf8');
  assert.equal((await listRawDrafts(root, f.project.id)).length, 1);
  await assert.rejects(restoreRawDraft(root, f.project.id, id, f.project.root), /越界/u);
  const previous = id.replace('-draft.docx', '-previous.docx');
  await fs.writeFile(path.join(directory, previous), Buffer.from('fake', 'utf8'));
  await fs.writeFile(path.join(directory, previous.replace('-previous.docx', '-previous.meta.json')), JSON.stringify({ sourcePath: 'C:/windows/system32/x.docx', at: '2026-10-20T00:00:00Z', bytes: 4 }), 'utf8');
  assert.equal((await listPreviousVersions(root, f.project.id)).length, 1);
  await assert.rejects(restorePreviousVersion(root, f.project.id, previous, f.project.root), /越界/u);
});

test('A05 Word 结构编辑删段：输出真的少段落', async t => {
  const zip = new JSZip();
  const paragraph = (text: string) => `<w:p><w:pPr><w:jc w:val="both"/></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document><w:body>${paragraph('ONE')}${paragraph('TWO')}${paragraph('THREE')}</w:body></w:document>`);
  const bytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
  const result = await rewriteDocxParagraphs(bytes, ['ONLY'], { structural: true });
  assert.equal(result.paragraphs, 1, `返回值应反映实际段数，实际 ${result.paragraphs}`);
  const after = await JSZip.loadAsync(result.bytes);
  const texts = bodyParagraphTexts(await after.file('word/document.xml')!.async('string'));
  assert.deepEqual(texts, ['ONLY'], '被删段落不能残留');
});

test('A06 手动批量审稿取消后不再请求下一个模型', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-batch-cancel-'));
  const local = path.join(root, 'local'), materials = path.join(root, 'materials');
  const workspace = new Workspace(local, materials); await workspace.initialize();
  const directory = path.join(root, '书'); await fs.mkdir(directory);
  const project = await workspace.attach(directory);
  const library = new LibraryStore(id => workspace.getProject(id), materials, (id, relative) => workspace.resolveChapterPath(id, relative));
  const characters = new CharacterStore(id => workspace.getProject(id), materials);
  await library.read(project.id); await characters.read(project.id);
  const calls: string[] = [];
  const gate: { release?: () => void } = {};
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const model = (JSON.parse(raw) as { model: string }).model; calls.push(model);
    if (model === 'first-model') await new Promise<void>(resolve => { gate.release = resolve; });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '{"summary":"独立报告","issues":[]}' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { gate.release?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); });
  const connections = new AIConnections(local, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  const base = { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, adapter: 'generic' as const, thinking: 'default' as const, contextWindow: 32768, maxOutputTokens: 2048, tokenParameter: 'max_tokens' as const, timeoutSeconds: 30 };
  let hash = ''; const ids: string[] = [];
  for (const model of ['first-model', 'second-model']) { const saved = await connections.save({ name: model, ...base, model, apiKey: `fictional-${model}` }, hash); hash = saved.hash; ids.push(saved.connections.at(-1)!.id); }
  const service = new AIService(local, connections, workspace, library, characters);
  const chapter = await workspace.createChapter(project.id, textDocument('林夏推开门。'));
  const batch = service.startReviewBatch({ projectId: project.id, chapterPath: chapter.path, sourceHash: chapter.hash, connectionIds: ids, reviewFormat: 'issues', instruction: '检查错别字' });
  for (let attempt = 0; attempt < 200 && !calls.length; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  const running = (await service.list(project.id)).find(task => task.mode === 'review' && task.status === 'running');
  assert.ok(running, '首个审稿任务应在运行中');
  await service.cancel(project.id, running!.id);
  gate.release?.();
  await batch;
  assert.deepEqual(calls, ['first-model'], `取消后不应再请求下一个模型，实际 ${calls.join(',')}`);
});

test('A04 整书替换后改名再撤销：写回当前文件名，章节仍可读', async t => {
  const f = await book(t);
  const { BookReplace } = await import('../src/main/book-replace');
  const service = new BookReplace(f.workspace, path.join(f.root, 'userdata'));
  const outcome = await service.run({ projectId: f.project.id, query: '第一章', replacement: '序章' });
  assert.ok(outcome.batchId, '应产生可撤销批次');
  const replaced = await f.workspace.readChapter(f.project.id, f.chapter.path);
  const renamed = await f.workspace.renameChapter({ projectId: f.project.id, path: replaced.path, expectedHash: replaced.hash, name: '新章节名' });
  assert.notEqual(renamed.path, replaced.path, '改名后路径应变化');
  await service.undo(f.project.id, outcome.batchId!);
  // 撤销后必须能按改名后的路径正常读取（旧实现会把旧字节写回历史旧名，导致读取报"名称已被占用"）
  const after = await f.workspace.readChapter(f.project.id, renamed.path);
  assert.match(JSON.stringify(after.content), /第一章正文/u, '撤销应把原文写回当前文件');
});
test('同类加固：角色资料写入拒绝越界文件名', async t => {
  const f = await book(t);
  const { CharacterStore } = await import('../src/main/characters');
  const store = new CharacterStore(id => f.workspace.getProject(id), f.materials);
  await assert.rejects(store.writeMaterial(f.project.id, '角色卡备份', '../escaped.json', Buffer.from('x')), /文件名不合法|越界/u);
  await assert.rejects(store.writeMaterial(f.project.id, '角色卡备份', 'a/b.json', Buffer.from('x')), /文件名不合法|越界/u);
  const ok = await store.writeMaterial(f.project.id, '角色卡备份', '人物卡-测试.json', Buffer.from('{}'));
  assert.match(ok, /人物卡-测试\.json$/u);
});
test('A01 闭环：恢复出的书重新打开后能看到世界观（资料自动装回本机资料目录）', async t => {
  const f = await book(t);
  const current = await f.workspace.readNotes(f.project.id);
  await f.workspace.saveNotes(f.project.id, { ...current.value, world: '潮汐城邦设定：雨季半年。' }, current.hash);
  const backup = await backupBook(f.workspace, f.project.id, path.join(f.root, '备份'), new Date('2026-10-20T02:00:00Z'));
  const restored = await restoreBackup(backup.folder, path.join(f.root, '恢复'), new Date('2026-10-20T03:00:00Z'));
  // 模拟"换一台机器/新装应用"：全新的 local/materials 根目录
  const freshLocal = path.join(f.root, 'fresh-local'), freshMaterials = path.join(f.root, 'fresh-materials');
  const fresh = new Workspace(freshLocal, freshMaterials); await fresh.initialize();
  const attached = await fresh.attach(restored.folder);
  const notes = await fresh.readNotes(attached.id);
  assert.match(JSON.stringify(notes.value), /潮汐城邦/u, '重新打开恢复出的书时，世界观应从 资料/ 装回本机');
});
