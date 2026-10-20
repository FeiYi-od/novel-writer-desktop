import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import type { AITask, Manuscript } from '../src/shared/contracts';
import { copyableText } from '../src/core/typography';

async function main() {
  const fixture = path.resolve('.artifacts', `review-decisions-desktop-${Date.now()}`), local = path.join(fixture, 'app-data');
  const bookA = path.join(fixture, '处理状态雨馆甲'), bookB = path.join(fixture, '处理状态海港乙');
  await Promise.all([fs.mkdir(bookA, { recursive: true }), fs.mkdir(bookB, { recursive: true })]);
  let callCount = 0;
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); assert.ok(body.messages[0].content.includes('只输出 JSON')); callCount++;
    const output = JSON.stringify({ summary: `虚构处理状态报告 ${callCount}`, issues: [
      { category: '错别字', quote: '雨生', replacement: '雨声', reason: '此处表示声音。', evidence: '' },
      { category: '错别字', quote: '信只', replacement: '信纸', reason: '此处表示纸张。', evidence: '' },
      { category: '错别字', quote: '灯或', replacement: '灯火', reason: '此处表示灯光。', evidence: '' },
      { category: '错别字', quote: '等侍', replacement: '等待', reason: '此处表示等待。', evidence: '' },
      { category: '世界观', quote: '未提供的原句', replacement: '不可直接采纳', reason: '虚构无依据建议。', evidence: '' }
    ] });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: output }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, require = createRequire(import.meta.url);
  let app: ElectronApplication | null = null; let page!: Page;
  const errors: string[] = [];
  const launch = async () => {
    app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: local } });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  };
  const open = async (folder: string) => {
    await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByText(`已打开「${path.basename(folder)}」`, { exact: false }).waitFor();
    return (await page.evaluate(() => window.writer.listProjects())).find(project => project.root === folder)!;
  };
  const showAI = async (source: Manuscript) => {
    await page.locator('.chapter-list button').filter({ hasText: source.path }).click();
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    await page.getByRole('button', { name: '打开 AI 写作与审稿', exact: true }).click();
  };
  const state = (id: string) => page.getByLabel(`处理状态 ${id}`, { exact: true });
  const waitState = (id: string, value: string) => page.waitForFunction(({ id, value }) => {
    const select = document.querySelector<HTMLSelectElement>(`select[aria-label="处理状态 ${id}"]`);
    return !!select && select.value === value && !select.disabled;
  }, { id, value });
  const setState = async (id: string, value: string) => { await state(id).selectOption(value); await waitState(id, value); };
  const review = async (projectId: string, connectionId: string) => {
    await page.getByLabel('审稿模型', { exact: true }).selectOption(connectionId); await page.getByLabel('结构化审稿', { exact: true }).check();
    const before = new Set((await page.evaluate(id => window.writer.aiTasks(id), projectId)).map(task => task.id));
    await page.getByRole('button', { name: '审阅已保存章节', exact: true }).click();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const task = (await page.evaluate(id => window.writer.aiTasks(id), projectId)).find(task => !before.has(task.id) && task.status !== 'running');
      if (task) { assert.equal(task.status, 'complete', task.error); await waitState('issue-1', 'pending'); return task; }
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(`New structured review did not finish: ${JSON.stringify(await page.evaluate(id => window.writer.aiTasks(id), projectId))}`);
  };
  const exitNormally = async () => { const closing = app!.waitForEvent('close'); await page.getByRole('button', { name: '保存并退出', exact: true }).click(); await closing; app = null; };
  const readDecisions = (task: AITask) => page.evaluate(({ projectId, id }) => window.writer.reviewDecisions(projectId, id), task);
  const history = () => page.locator('.ai-history > button');
  const reread = () => page.getByRole('button', { name: '重新读取处理状态', exact: true }).click();
  try {
    await launch(); const projectA = await open(bookA);
    const sourceA = await page.evaluate(id => window.writer.copyChapter(id, { type: 'doc', content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '甲书雨馆' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '雨生打湿信只。灯或旁的林夏仍在等侍。', marks: [{ type: 'italic' }] }] }
    ] }), projectA.id);
    const bytesA = await fs.readFile(path.join(bookA, sourceA.path));
    const connectionId = await page.evaluate(async baseUrl => {
      const snapshot = await window.writer.aiConnections();
      const saved = await window.writer.saveAIConnection({ name: '本机虚构审稿', model: 'mock-decision-review', baseUrl, adapter: 'generic', thinking: 'default', timeoutSeconds: 60, contextWindow: 32768, maxOutputTokens: 1600, tokenParameter: 'max_tokens' }, snapshot.hash);
      return saved.connections.at(-1)!.id;
    }, endpoint);
    await page.reload(); await open(bookA); await showAI(sourceA);
    const reportA1 = await review(projectA.id, connectionId);
    await page.getByLabel('采纳建议 issue-1', { exact: true }).check();
    await setState('issue-1', 'accepted'); assert.equal(await page.getByLabel('采纳建议 issue-1', { exact: true }).isChecked(), false);
    await setState('issue-2', 'ignored'); await setState('issue-3', 'false-positive');
    assert.equal(await page.getByLabel('采纳建议 issue-2', { exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel('采纳建议 issue-3', { exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel('采纳建议 issue-5', { exact: true }).isDisabled(), true);
    assert.equal(await state('issue-5').locator('option[value="accepted"]').evaluate(option => (option as HTMLOptionElement).disabled), true);
    await setState('issue-5', 'false-positive');
    assert.deepEqual((await readDecisions(reportA1)).items.map(item => item.status), ['accepted', 'ignored', 'false-positive', 'pending', 'false-positive']);
    const reportA2 = await review(projectA.id, connectionId);
    assert.deepEqual((await readDecisions(reportA2)).items.map(item => item.status), Array(5).fill('pending'), 'Identical ordinal issue IDs in another report must stay independent');
    await history().nth(1).click(); await waitState('issue-1', 'accepted');
    await exitNormally(); await launch(); await open(bookA); await showAI(sourceA);
    await history().nth(1).click(); await waitState('issue-1', 'accepted'); await waitState('issue-2', 'ignored'); await waitState('issue-3', 'false-positive');
    await page.getByLabel('采纳建议 issue-1', { exact: true }).check();
    await page.getByText('预览选中修改后的全文', { exact: true }).click();
    assert.match(await page.getByLabel('审稿修订预览').innerText(), /雨声打湿信只/);
    const before = new Set((await fs.readdir(bookA)).filter(name => name.endsWith('.docx')));
    await page.getByRole('button', { name: '采纳选中建议并另存 DOCX', exact: true }).click();
    await page.getByRole('button', { name: '重新处理 issue-1', exact: true }).waitFor();
    const saved = await readDecisions(reportA1), applied = saved.items.find(item => item.issueId === 'issue-1')!;
    assert.equal(applied.status, 'applied'); assert.match(applied.outputHash!, /^[a-f0-9]{64}$/);
    assert.deepEqual((await fs.readdir(bookA)).filter(name => name.endsWith('.docx') && !before.has(name)), [applied.outputPath]);
    const revised = await page.evaluate(({ projectId, name }) => window.writer.readChapter(projectId, name), { projectId: projectA.id, name: applied.outputPath! });
    assert.equal(revised.hash, applied.outputHash); assert.match(typeof revised.content === 'string' ? revised.content : copyableText(revised.content), /雨声打湿信只/);
    assert.equal(await page.getByLabel('采纳建议 issue-1', { exact: true }).isDisabled(), true);
    assert.deepEqual(await fs.readFile(path.join(bookA, sourceA.path)), bytesA);
    await page.getByRole('button', { name: '重新处理 issue-1', exact: true }).scrollIntoViewIfNeeded();
    const png = await app!.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
    await fs.writeFile(path.resolve('.artifacts/review-decisions.png'), Buffer.from(png, 'base64'));
    await page.getByRole('button', { name: '重新处理 issue-1', exact: true }).click(); await waitState('issue-1', 'pending');
    const decisionFile = path.join(local, 'review-decisions', projectA.id, `${reportA1.id}.json`), decisionBytes = await fs.readFile(decisionFile);
    await fs.writeFile(decisionFile, '{broken'); await reread();
    await page.getByRole('alert').filter({ hasText: '审稿处理记录损坏' }).waitFor();
    assert.equal(await state('issue-2').inputValue(), 'ignored'); assert.equal(await state('issue-2').isDisabled(), true);
    assert.equal(await fs.readFile(decisionFile, 'utf8'), '{broken'); await fs.writeFile(decisionFile, decisionBytes); await reread(); await waitState('issue-2', 'ignored');
    // Same DOCX bytes with changed supported-format cache also invalidate the old report.
    const structureFile = path.join(bookA, '小说资料', 'documents', `${sourceA.hash}.json`), structureBytes = await fs.readFile(structureFile);
    const changed = JSON.parse(structureBytes.toString()); changed.content.content[1].content[0].marks = [{ type: 'bold' }];
    await fs.writeFile(structureFile, JSON.stringify(changed)); await reread();
    await page.getByRole('alert').filter({ hasText: '本报告版本已失效' }).waitFor();
    assert.equal(await state('issue-2').inputValue(), 'ignored'); assert.equal(await state('issue-2').isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '采纳选中建议并另存 DOCX' }).isDisabled(), true);
    await fs.writeFile(structureFile, structureBytes); await reread(); await waitState('issue-2', 'ignored');
    // Hold only a completed IPC response; main-process pending is already clear.
    // The renderer must still protect exit after switching reports (old component unmounted).
    await app!.evaluate(({ ipcMain }, taskId) => {
      const globals = globalThis as any; globals.__reviewHold = taskId; globals.__reviewHeld = [];
      const original = (ipcMain as any)._invokeHandlers.get('ai:review-decisions'); ipcMain.removeHandler('ai:review-decisions');
      ipcMain.handle('ai:review-decisions', async (event, ...args) => {
        const result = await original(event, ...args);
        if (args[1] === globals.__reviewHold) await new Promise<void>(resolve => globals.__reviewHeld.push(resolve));
        return result;
      });
    }, reportA1.id);
    await reread();
    await page.waitForFunction(() => [...document.querySelectorAll('span')].some(element => element.textContent === '正在读取或保存审稿处理状态…'));
    const heldDeadline = Date.now() + 5000;
    while (!(await app!.evaluate(() => (globalThis as any).__reviewHeld.length)) && Date.now() < heldDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(await app!.evaluate(() => (globalThis as any).__reviewHeld.length));
    await history().nth(0).click(); await waitState('issue-1', 'pending');
    await page.getByRole('button', { name: '保存并退出', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '审稿问题处理正在处理' }).waitFor(); assert.equal(app!.process().exitCode, null);
    await app!.evaluate(() => { const globals = globalThis as any; globals.__reviewHold = ''; for (const release of globals.__reviewHeld.splice(0)) release(); });
    await waitState('issue-2', 'pending'); assert.equal(await state('issue-2').inputValue(), 'pending');
    await page.getByText('虚构处理状态报告 2', { exact: true }).waitFor();
    assert.deepEqual((await readDecisions(reportA1)).items.map(item => item.status), ['pending', 'ignored', 'false-positive', 'pending', 'false-positive']);
    // Freeze history polling briefly so an externally replaced same-ID report
    // cannot update the displayed text before its decision reply is validated.
    const frozenTasks = await page.evaluate(id => window.writer.aiTasks(id), projectA.id);
    await app!.evaluate(({ ipcMain }, frozen) => {
      const globals = globalThis as any; globals.__reviewFrozenTasks = frozen;
      const original = (ipcMain as any)._invokeHandlers.get('ai:tasks'); ipcMain.removeHandler('ai:tasks');
      ipcMain.handle('ai:tasks', (event, ...args) => globals.__reviewFrozenTasks && args[0] === globals.__reviewFrozenTasks[0].projectId ? globals.__reviewFrozenTasks : original(event, ...args));
    }, frozenTasks);
    const reportFile = path.join(local, 'ai-tasks', projectA.id, `${reportA2.id}.json`), reportBytes = await fs.readFile(reportFile);
    const replaced = JSON.parse(reportBytes.toString()), replacedReport = JSON.parse(replaced.text);
    replacedReport.summary = '外部同 ID 新报告'; replacedReport.issues[0].replacement = '错误套用外部新报告'; replaced.text = JSON.stringify(replacedReport);
    await page.getByLabel('采纳建议 issue-1', { exact: true }).check();
    const beforeIdentityReject = (await fs.readdir(bookA)).filter(name => name.endsWith('.docx')).sort();
    await fs.writeFile(reportFile, JSON.stringify(replaced));
    // No reread: export must carry the identity/hash that the author actually viewed.
    await page.getByRole('button', { name: '采纳选中建议并另存 DOCX', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '问题处理记录与本书报告不一致' }).waitFor();
    assert.deepEqual((await fs.readdir(bookA)).filter(name => name.endsWith('.docx')).sort(), beforeIdentityReject);
    await assert.rejects(fs.access(path.join(local, 'review-decisions', projectA.id, `${reportA2.id}.json`)), { code: 'ENOENT' });
    await reread();
    await page.getByRole('alert').filter({ hasText: '问题处理记录与本书报告不一致' }).waitFor();
    await page.getByText('虚构处理状态报告 2', { exact: true }).waitFor();
    assert.equal(await state('issue-1').isDisabled(), true);
    await fs.writeFile(reportFile, reportBytes); await app!.evaluate(() => { (globalThis as any).__reviewFrozenTasks = null; });
    await reread(); await waitState('issue-1', 'pending');
    const projectB = await open(bookB);
    const sourceB = await page.evaluate(id => window.writer.copyChapter(id, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '乙书海港的雨生打湿信只，灯或中有人等侍。' }] }] }), projectB.id);
    const bytesB = await fs.readFile(path.join(bookB, sourceB.path));
    await open(bookB); await showAI(sourceB); const reportB = await review(projectB.id, connectionId);
    assert.deepEqual((await readDecisions(reportB)).items.map(item => item.status), Array(5).fill('pending'));
    await setState('issue-2', 'accepted');
    assert.equal((await readDecisions(reportA1)).items[1].status, 'ignored'); assert.equal((await readDecisions(reportB)).items[1].status, 'accepted');
    assert.deepEqual(await fs.readFile(path.join(bookA, sourceA.path)), bytesA); assert.deepEqual(await fs.readFile(path.join(bookB, sourceB.path)), bytesB);
    assert.equal(callCount, 3); assert.deepEqual(errors, []);
    await exitNormally();
    console.log('Review decisions desktop passed: actual UI pending/accepted/ignored/false-positive/applied and explicit reset, disabled invalid suggestions, restart persistence, unchanged source bytes and rich DOCX copy, report/book isolation, corrupt-record preservation, same-byte structure stale read-only, delayed read across report unmount and save/exit protection. Local fictional mock only.');
  } catch (error) {
    if (app) await fs.writeFile(path.join(fixture, 'failure-ui.txt'), await page.locator('body').innerText().catch(() => 'No live test page'));
    throw error;
  } finally {
    const remaining = app as ElectronApplication | null;
    if (remaining) await remaining.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {});
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
