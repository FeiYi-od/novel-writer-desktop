import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import mammoth from 'mammoth';
import type { AITask } from '../src/shared/contracts';

type Phase = 'reports' | 'cancel' | 'isolation';
type MockBody = { model: string; messages: { role: string; content: string }[] };

async function main() {
  const fixture = path.resolve('.artifacts', `multi-review-desktop-${Date.now()}`);
  const bookA = path.join(fixture, '三审雨馆甲'), bookB = path.join(fixture, '三审海港乙');
  const local = path.join(fixture, 'app-data');
  await Promise.all([fs.mkdir(bookA, { recursive: true }), fs.mkdir(bookB, { recursive: true })]);
  await fs.writeFile(path.join(bookB, '乙书原稿.txt'), '　　乙书蓝鲸守在港口。');
  const originalB = await fs.readFile(path.join(bookB, '乙书原稿.txt'));
  const calls: { phase: Phase; body: MockBody }[] = [];
  let phase: Phase = 'reports', activeReports = 0, maximumActiveReports = 0;
  let releaseIsolatedReview: (() => void) | undefined;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const candidate = '林夏听见雨生。\n她收起了信纸。';
  const reportOne = JSON.stringify({ summary: '审稿一：定位雨生错字。', issues: [{ category: '错别字', quote: '雨生', replacement: '雨声', reason: '此处表示雨的声音。', evidence: '' }] });
  const reportThree = JSON.stringify({ summary: '审稿三：独立措辞建议。', issues: [{ category: '语病', quote: '信纸', replacement: '信笺', reason: '仅用于虚构独立报告测试。', evidence: '' }] });
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw) as MockBody, requestPhase = phase;
    calls.push({ phase: requestPhase, body });
    if (requestPhase === 'reports') {
      activeReports++; maximumActiveReports = Math.max(maximumActiveReports, activeReports);
      let settled = false;
      const settle = () => { if (!settled) { settled = true; activeReports--; } };
      response.once('finish', settle); response.once('close', settle);
    }
    const output = body.model === 'mock-writer' ? candidate : body.model === 'mock-review-1' ? reportOne : body.model === 'mock-review-2' ? '这不是有效 JSON；保留失败结果。' : reportThree;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: output }, finish_reason: null }] })}\n\n`);
    const finish = () => { if (!response.destroyed) response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`); };
    // Keep the first review open so UI cancellation, exit guards and late results are real.
    if (body.model === 'mock-review-1' && requestPhase !== 'reports') {
      if (requestPhase === 'isolation') releaseIsolatedReview = finish;
      return;
    }
    const timer = setTimeout(() => { timers.delete(timer); finish(); }, 120); timers.add(timer);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const require = createRequire(import.meta.url);
  let app: ElectronApplication | null = null, page!: Page;
  const errors: string[] = [];
  const launch = async () => {
    app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: local } });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  };
  const open = async (folder: string) => {
    await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click({ force: true });
    await page.getByText(`已打开「${path.basename(folder)}」`, { exact: false }).waitFor();
  };
  // 侧栏在切书后持续重排，Playwright 的"稳定"检查会一直不过；用 force 直接点，
  // 仍然走真实事件与 React 处理，只是跳过稳定性等待。
  const showAI = async () => {
    await page.getByRole('button', { name: '写作空间', exact: true }).click({ force: true });
    await page.getByRole('button', { name: 'AI', exact: true }).click({ force: true });
    await page.getByRole('button', { name: '打开 AI 写作与审稿', exact: true }).click({ force: true });
  };
  const tasks = (projectId: string) => page.evaluate(id => window.writer.aiTasks(id), projectId);
  const waitTask = async (projectId: string, taskId: string, done: (task: AITask) => boolean) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const task = (await tasks(projectId)).find(task => task.id === taskId);
      if (task && done(task)) return task;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(`Multi-review task did not reach expected state: ${taskId}; ${JSON.stringify(await tasks(projectId))}`);
  };
  const terminal = (task: AITask) => task.status !== 'running' && task.autoReviews?.length === 3 && task.autoReviews.every(review => !['pending', 'running'].includes(review.status));
  const start = async (projectId: string) => {
    const previous = new Set((await tasks(projectId)).map(task => task.id));
    const button = page.getByRole('button', { name: '生成正文候选', exact: true });
    await button.waitFor(); await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(button => button.textContent === '生成正文候选')?.disabled);
    await button.click();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const task = (await tasks(projectId)).find(task => task.mode === 'write' && !previous.has(task.id));
      if (task) return task;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error('UI did not create a multi-review parent');
  };
  const parentButton = () => page.locator('.ai-history button').filter({ hasText: '正文候选' }).first();
  const reportButton = (index: number, name: string) => page.getByRole('button', { name: `查看自动审稿报告 ${index} · ${name}`, exact: true });
  try {
    await launch(); await open(bookA);
    const projectA = (await page.evaluate(() => window.writer.listProjects())).find(project => project.root === bookA)!;
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节', exact: true }).click();
    await page.locator('.tiptap').fill('林夏坐在雨馆窗边。');
    await page.getByRole('button', { name: '保存 DOCX', exact: true }).click();
    await page.getByText('DOCX 已保存到所选文件夹', { exact: true }).waitFor();
    const chapterName = (await fs.readdir(bookA)).find(name => name.endsWith('.docx'))!;
    const originalA = await fs.readFile(path.join(bookA, chapterName));
    await page.getByLabel('人物笔记').fill('甲书林夏在雨馆中倾听雨声。');
    await page.getByRole('button', { name: '保存本书资料', exact: true }).click();
    await page.getByText('本书资料已保存', { exact: true }).waitFor();
    const profiles = await page.evaluate(async baseUrl => {
      const profiles = [];
      for (const [index, name] of ['写作模型', '审稿一', '审稿二', '审稿三'].entries()) {
        const snapshot = await window.writer.aiConnections();
        const next = await window.writer.saveAIConnection({ name, model: index ? `mock-review-${index}` : 'mock-writer', baseUrl, adapter: 'generic', thinking: 'default', timeoutSeconds: 60, contextWindow: 32768, maxOutputTokens: 1000, tokenParameter: 'max_tokens', apiKey: 'fictional-multi-review-key' }, snapshot.hash);
        profiles.push(next.connections.at(-1)!);
      }
      return profiles;
    }, endpoint);
    // Reload the renderer so its model settings state reads the IPC-created profiles.
    await page.reload(); await open(bookA);
    await page.locator('.chapter-list button').filter({ hasText: chapterName }).click(); await showAI();
    await page.getByLabel('写作模型', { exact: true }).selectOption(profiles[0].id);
    await page.getByLabel('审稿模型', { exact: true }).selectOption(profiles[1].id);
    await page.getByRole('button', { name: '添加审稿模型', exact: true }).click();
    await page.getByLabel('追加审稿模型 2', { exact: true }).selectOption(profiles[2].id);
    await page.getByRole('button', { name: '添加审稿模型', exact: true }).click();
    await page.getByLabel('追加审稿模型 3', { exact: true }).selectOption(profiles[3].id);
    assert.equal(await page.getByRole('button', { name: '添加审稿模型', exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel('追加审稿模型 2', { exact: true }).locator(`option[value="${profiles[1].id}"]`).evaluate(option => (option as HTMLOptionElement).disabled), true, 'Already selected reviewers cannot be selected twice');
    try { await page.getByRole('checkbox', { name: '生成后自动送审', exact: true }).check({ timeout: 8000 }); }
    catch (failure) {
      const info = await page.evaluate(() => { const box = document.querySelector('input[aria-label="生成后自动送审"]') as HTMLInputElement | null; return { exists: !!box, disabled: box?.disabled ?? null, aiPage: !!document.querySelector('.ai-columns'), dialogs: document.querySelectorAll('[role=dialog]').length }; });
      console.error('CHECKBOX_STATE', JSON.stringify(info));
      throw failure;
    }
    assert.equal(calls.length, 0, 'Configuring a review queue must not call any model');
    // A real application restart retains the per-book queue and encrypted test profiles.
    const closing = app!.waitForEvent('close');
    await page.getByRole('button', { name: '保存并退出', exact: true }).click(); await closing; app = null;
    await launch(); await open(bookA); await page.locator('.chapter-list button').filter({ hasText: chapterName }).click(); await showAI();
    assert.equal(await page.getByLabel('写作模型', { exact: true }).inputValue(), profiles[0].id);
    assert.equal(await page.getByLabel('审稿模型', { exact: true }).inputValue(), profiles[1].id);
    assert.equal(await page.getByLabel('追加审稿模型 2', { exact: true }).inputValue(), profiles[2].id);
    assert.equal(await page.getByLabel('追加审稿模型 3', { exact: true }).inputValue(), profiles[3].id);
    assert.equal(await page.getByRole('checkbox', { name: '生成后自动送审', exact: true }).isChecked(), true);
    assert.equal(calls.length, 0);

    const initial = await start(projectA.id), parent = await waitTask(projectA.id, initial.id, terminal);
    assert.equal(parent.status, 'complete'); assert.equal(parent.autoReview, undefined);
    assert.deepEqual(parent.autoReviews!.map(review => review.status), ['complete', 'failed', 'complete']);
    assert.deepEqual(calls.filter(call => call.phase === 'reports').map(call => call.body.model), ['mock-writer', 'mock-review-1', 'mock-review-2', 'mock-review-3']);
    assert.equal(maximumActiveReports, 1, 'Review HTTP calls must run in order without overlapping');
    const reports = await tasks(projectA.id);
    for (const [index, review] of parent.autoReviews!.entries()) {
      const child = reports.find(task => task.id === review.taskId)!;
      assert.ok(child); assert.equal(child.projectId, projectA.id); assert.equal(child.reviewTaskId, parent.id);
      assert.equal(child.sourceText, parent.text); assert.equal(child.sourceHash, parent.sourceHash);
      assert.equal(child.contextHash, parent.contextHash); assert.equal(child.context, parent.context);
      assert.equal(child.status, index === 1 ? 'failed' : 'complete');
    }
    for (const call of calls.filter(call => call.body.model !== 'mock-writer')) {
      assert.match(call.body.messages[0].content, /甲书林夏/); assert.match(call.body.messages[1].content, /林夏听见雨生/);
      assert.doesNotMatch(JSON.stringify(call.body), /乙书蓝鲸/);
    }
    await reportButton(3, '审稿三').click(); await page.getByText('审稿三：独立措辞建议。', { exact: true }).waitFor();
    // Two completed reports of the same candidate are comparable side by side; the failed one is not.
    await page.locator('.ai-merged').waitFor();
    const merged = await page.locator('.ai-merged').innerText();
    assert.match(merged, /2 份报告 \/ 2 条意见 \/ 冲突 0 条/u);
    assert.match(merged, /审稿一 \/ mock-review-1/u); assert.match(merged, /审稿三 \/ mock-review-3/u);
    assert.match(merged, /不投票、不合并 issue 序号/u);
    await page.locator('.merged-member').filter({ hasText: '审稿一 / mock-review-1' }).getByRole('button', { name: '查看这份报告' }).click();
    await page.getByText('审稿一：定位雨生错字。', { exact: true }).waitFor();
    await page.getByLabel('采纳建议 issue-1', { exact: true }).check();
    await parentButton().click(); await reportButton(1, '审稿一').click();
    await page.getByText('审稿一：定位雨生错字。', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('采纳建议 issue-1', { exact: true }).isChecked(), false, 'Selections from another report must not cross into this report');
    await page.getByLabel('采纳建议 issue-1', { exact: true }).check();
    await page.getByText('预览选中修改后的全文', { exact: true }).click();
    const preview = await page.getByLabel('审稿修订预览').textContent();
    assert.equal(preview, '林夏听见雨声。\n她收起了信纸。'); assert.doesNotMatch(preview ?? '', /信笺/);
    await page.getByRole('button', { name: '采纳选中建议并另存 DOCX', exact: true }).click();
    await page.getByText('已另存修订稿', { exact: false }).waitFor();
    const revisions = (await fs.readdir(bookA)).filter(name => name.endsWith('.docx') && name !== chapterName);
    assert.equal(revisions.length, 1, 'Only the explicitly selected report creates a revision');
    const revision = (await mammoth.extractRawText({ path: path.join(bookA, revisions[0]) })).value;
    assert.match(revision, /　　林夏听见雨声。/); assert.match(revision, /　　她收起了信纸。/); assert.doesNotMatch(revision, /信笺/);
    assert.deepEqual(await fs.readFile(path.join(bookA, chapterName)), originalA);

    phase = 'cancel'; await parentButton().click(); const cancelling = await start(projectA.id);
    await waitTask(projectA.id, cancelling.id, task => task.autoReviews?.[0].status === 'running');
    await page.getByRole('button', { name: '保存并退出', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '模型任务或文件操作尚未完成' }).first().waitFor();
    assert.equal(app!.process().exitCode, null, 'Running review queues block one-click exit');
    await page.getByRole('button', { name: '停止整条写审流程', exact: true }).click();
    const cancelled = await waitTask(projectA.id, cancelling.id, terminal);
    assert.deepEqual(calls.filter(call => call.phase === 'cancel').map(call => call.body.model), ['mock-writer', 'mock-review-1']);
    assert.deepEqual(cancelled.autoReviews!.slice(1).map(review => review.status), ['skipped', 'skipped']);
    assert.equal((await tasks(projectA.id)).find(task => task.id === cancelled.autoReviews![0].taskId)?.status, 'cancelled');
    assert.deepEqual(await fs.readFile(path.join(bookA, chapterName)), originalA);

    phase = 'isolation'; const isolated = await start(projectA.id);
    await waitTask(projectA.id, isolated.id, task => task.autoReviews?.[0].status === 'running');
    await page.getByRole('button', { name: '写作空间', exact: true }).click({ force: true }); await open(bookB);
    const projectB = (await page.evaluate(() => window.writer.listProjects())).find(project => project.root === bookB)!;
    await page.waitForFunction(() => [...document.querySelectorAll('.chapter-list button')].some(button => (button.textContent ?? '').includes('乙书原稿.txt')), undefined, { timeout: 20000 });
    // 该列表在切书后持续重排，Playwright 的稳定点击不适用；直接派发一次真实点击。
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('.chapter-list button')].find(item => (item.textContent ?? '').includes('乙书原稿.txt')) as HTMLButtonElement | undefined;
      if (!button) throw new Error('乙书章节未出现在列表');
      button.click();
    }); await showAI();
    assert.equal(await page.getByLabel('追加审稿模型 2', { exact: true }).count(), 0);
    assert.equal(await page.getByLabel('审稿模型', { exact: true }).inputValue(), '');
    // 该页在切书后会反复重渲染，Playwright 的 isChecked 会一直等到超时；直接读 DOM 值。
    const bookBBox = await page.evaluate(() => {
      const box = document.querySelector('input[aria-label="生成后自动送审"]') as HTMLInputElement | null;
      return box ? box.checked : null;
    });
    assert.equal(bookBBox, false, '乙书不应继承甲书的自动送审设置');
    assert.ok(releaseIsolatedReview); releaseIsolatedReview();
    const late = await waitTask(projectA.id, isolated.id, terminal);
    assert.deepEqual(late.autoReviews!.map(review => review.status), ['complete', 'failed', 'complete']);
    assert.equal((await tasks(projectB.id)).length, 0);
    assert.doesNotMatch(await page.locator('.ai-history').textContent() ?? '', /正文候选|审稿报告/);
    assert.equal(await page.getByLabel('AI 输出', { exact: true }).count(), 0, 'Late A results cannot populate book B');
    assert.deepEqual(await fs.readFile(path.join(bookA, chapterName)), originalA); assert.deepEqual(await fs.readFile(path.join(bookB, '乙书原稿.txt')), originalB);
    await page.getByRole('button', { name: '写作空间', exact: true }).click({ force: true }); await open(bookA);
    await page.locator('.chapter-list button').filter({ hasText: chapterName }).click(); await showAI();
    await parentButton().click(); await reportButton(3, '审稿三').waitFor();
    assert.equal(await page.getByLabel('追加审稿模型 3', { exact: true }).inputValue(), profiles[3].id);
    await page.locator('.full-view:not([hidden])').evaluate(element => { element.scrollTop = 0; });
    await page.locator('.ai-page').filter({ visible: true }).evaluate(element => { element.scrollTop = 0; });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const png = await app!.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
    await fs.writeFile(path.resolve('.artifacts/multi-review.png'), Buffer.from(png, 'base64'));
    assert.deepEqual(errors, []);
    console.log('Multi-review desktop passed: three UI-selected reviewers, persisted queue after app restart, sequential success/failure/success with independent reports, single-report revision DOCX and unchanged originals, whole-queue cancellation, busy exit protection, and late-result isolation between two books.');
  } catch (error) {
    await fs.writeFile(path.join(fixture, 'failure-calls.json'), JSON.stringify(calls, null, 2));
    await fs.writeFile(path.join(fixture, 'failure-ui.txt'), await page.locator('body').innerText().catch(() => 'No live test page'));
    await fs.writeFile(path.join(fixture, 'failure-forms.json'), JSON.stringify(await page.locator('select').evaluateAll(elements => elements.map(element => { const select = element as HTMLSelectElement; return { label: select.getAttribute('aria-label'), value: select.value, options: Array.from(select.options).map(option => ({ value: option.value, disabled: option.disabled })) }; })).catch(() => []), null, 2));
    throw error;
  } finally {
    const remaining = app as ElectronApplication | null;
    if (remaining) await remaining.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {});
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
