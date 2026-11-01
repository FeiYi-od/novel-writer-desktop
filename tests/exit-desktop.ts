import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import mammoth from 'mammoth';
import { createServer } from 'node:http';
import { copyableText } from '../src/core/typography';

async function main() {
  const fixture = path.resolve('.artifacts', `exit-desktop-${Date.now()}`), folder = path.join(fixture, '虚构退出小说'), local = path.join(fixture, 'app-data'); await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url); let app: ElectronApplication | null = null; let page!: Page; let projectId = '', chapterPath = '';
  const launch = async () => { app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: local } }); page = await app.firstWindow(); page.setDefaultTimeout(15000); };
  const open = async () => { await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder); await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click(); await page.getByText('已打开「虚构退出小说」', { exact: false }).waitFor(); projectId = (await page.evaluate(() => window.writer.listProjects()))[0].id; };
  const exited = async () => { const closing = app!.waitForEvent('close'); await page.getByRole('button', { name: '保存并退出', exact: true }).click(); await closing; app = null; };
  const expectFailedExit = async (expected: RegExp) => {
    const attempts: string[] = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.getByRole('button', { name: '保存并退出', exact: true }).click();
      const alert = page.getByRole('alert').filter({ hasText: '保存并退出未完成' }).first();
      await alert.waitFor();
      const message = await alert.innerText(); attempts.push(message);
      if (expected.test(message)) return;
      // A just-opened chapter can still have its read-only capability report in flight.
      // That preflight refusal occurs before checkpointing, so it is not a conflict result.
      assert.match(message, /模型任务或文件操作尚未完成/u, `保存退出出现非预期错误：${message}`);
      await page.waitForTimeout(100);
    }
    assert.fail(`保存退出始终未到达预期分支：${JSON.stringify(attempts)}`);
  };
  const server = createServer((_, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.write('data: {"choices":[{"index":0,"delta":{"content":"未完成的虚构候选"}}]}\n\n'); }); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    await launch(); await open(); await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).click(); await page.locator('.tiptap').fill('保存退出后的虚构正文。'); chapterPath = (await page.evaluate(id => window.writer.chapters(id), projectId))[0].path;
    await page.getByLabel('人物笔记').fill('明确保存的虚构人物设定。');
    await page.getByRole('button', { name: '模型设置', exact: true }).click(); await page.getByLabel('连接名称', { exact: true }).fill('保存退出测试连接'); await page.getByLabel('API 基础地址', { exact: true }).fill('http://127.0.0.1:11434/v1');
    await page.getByRole('button', { name: '保存并退出', exact: true }).click(); await page.getByRole('alert').filter({ hasText: '保存并退出未完成' }).first().waitFor(); assert.equal(app!.process().exitCode, null); assert.ok(await page.getByLabel('模型名称', { exact: true }).isVisible());
    await page.getByLabel('模型名称', { exact: true }).fill('local-fixture');
    await page.getByRole('button', { name: '嵌入模型', exact: true }).click(); await page.getByLabel('嵌入模型提供商').selectOption('ollama_embedding');
    await page.getByRole('button', { name: '重排序模型', exact: true }).click(); await page.getByLabel('重排序模型提供商').selectOption('tei_rerank');
    await exited();
    assert.match((await mammoth.extractRawText({ path: path.join(folder, chapterPath) })).value, /　　保存退出后的虚构正文。/);
    const aux = JSON.parse(await fs.readFile(path.join(local, 'auxiliary-models.json'), 'utf8')); assert.deepEqual(aux.connections.map((c: any) => c.kind).sort(), ['embedding', 'rerank']);
    assert.equal(JSON.parse(await fs.readFile(path.join(local, 'ai-connections.json'), 'utf8')).connections[0].model, 'local-fixture');
    assert.match(await fs.readFile(path.join(local, '创作资料', projectId, '创作笔记.md'), 'utf8'), /明确保存的虚构人物设定/);

    // External edits stop the exit; the renderer draft and recovery checkpoint survive.
    await launch(); await open(); await page.locator('.chapter-list button').filter({ hasText: chapterPath }).click(); await page.locator('.tiptap').fill('外部冲突时仍要保留的本地草稿。'); const external = Buffer.from('外部修改的正文文件，不能覆盖'); await fs.writeFile(path.join(folder, chapterPath), external);
    await expectFailedExit(/文件已被其他程序修改/u);
    assert.equal(app!.process().exitCode, null); assert.match(await page.locator('.tiptap').textContent() ?? '', /本地草稿/); assert.deepEqual(await fs.readFile(path.join(folder, chapterPath)), external);
    const pending = (await page.evaluate(id => window.writer.recoveryDrafts(id), projectId)).find(draft => draft.status === 'pending' && draft.sourcePath === chapterPath);
    assert.ok(pending, '外部版本冲突后必须有当前章节的 pending 草稿');
    const recovered = await page.evaluate(({ projectId, id }) => window.writer.readRecoveryDraft(projectId, id), { projectId, id: pending.id });
    assert.match(copyableText(recovered.content), /外部冲突时仍要保留的本地草稿。/u, '恢复区必须保存本次编辑内容');
    await app!.evaluate(({ app: instance }) => instance.exit(0)); app = null;
    // No one-click adoption of an unconfirmed material draft, even when hidden.
    await launch(); await open(); await page.getByText('更多功能', { exact: true }).click(); await page.getByRole('button', { name: '资料转换', exact: true }).click(); await page.getByLabel('转换原文').fill('未确认的设定不能进入正史。'); await page.getByRole('button', { name: '保存并退出', exact: true }).click(); await page.getByRole('alert').filter({ hasText: '未确认的AI资料不会自动采用' }).first().waitFor(); assert.equal(app!.process().exitCode, null);
    await app!.evaluate(({ app: instance }) => instance.exit(0)); app = null;
    // Running model requests are checked in the main process, beyond page dirty state.
    await launch(); await open(); const doc = await page.evaluate(id => window.writer.createChapter(id), projectId);
    const saved = await page.evaluate(async endpoint => { const snapshot = await window.writer.aiConnections(); return window.writer.saveAIConnection({ name: '运行中的测试模型', model: 'mock', baseUrl: endpoint, adapter: 'generic', thinking: 'default', timeoutSeconds: 60, contextWindow: 32768, maxOutputTokens: 1000, tokenParameter: 'max_tokens' }, snapshot.hash); }, `http://127.0.0.1:${(server.address() as any).port}/v1`);
    const task = await page.evaluate(({ doc, id }) => window.writer.startAI({ projectId: doc.projectId, chapterPath: doc.path, sourceHash: doc.hash, connectionId: id, mode: 'write', instruction: '虚构退出测试' }), { doc, id: saved.connections.at(-1)!.id });
    await page.getByRole('button', { name: '保存并退出', exact: true }).click(); await page.getByRole('alert').filter({ hasText: '模型任务或文件操作尚未完成' }).first().waitFor(); assert.equal(app!.process().exitCode, null); await page.evaluate(({ projectId, id }) => window.writer.cancelAI(projectId, id), { projectId, id: task.id }); await page.waitForFunction(async ({ projectId, id }) => (await window.writer.aiTasks(projectId)).find(t => t.id === id)?.status === 'cancelled', { projectId, id: task.id });
    await exited(); assert.deepEqual(await fs.readFile(path.join(folder, chapterPath)), external);
    console.log('Save/exit desktop passed: invalid model leaves window, one-click DOCX/notes/chat/embedding/rerank save, restart, external conflict/checkpoint, unconfirmed material protection, live task block and cancellation.');
  } finally { const remaining = app as ElectronApplication | null; if (remaining) await remaining.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
