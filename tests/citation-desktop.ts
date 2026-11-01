import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  const calls: { model: string; messages: { content: string }[] }[] = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); calls.push(body);
    const output = body.model === 'mock-citation-reviewer'
      ? JSON.stringify({ summary: '仅用于检索引用测试的虚构审稿。', issues: [{ category: '错别字', quote: '雨生', replacement: '雨声', reason: '描述声音。', evidence: '' }] })
      : '林夏听见雨生。';
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: output }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = (server.address() as { port: number }).port;
  const fixture = path.resolve('.artifacts', `citation-desktop-${Date.now()}`), bookA = path.join(fixture, '引用学园甲'), bookB = path.join(fixture, '引用海港乙');
  await Promise.all([fs.mkdir(bookA, { recursive: true }), fs.mkdir(bookB, { recursive: true })]);
  const factNames = Array.from({ length: 11 }, (_, i) => `依据${String(i).padStart(2, '0')}.txt`);
  await Promise.all(factNames.map((name, i) => fs.writeFile(path.join(bookA, name), `　　银叶第${i}条规则：鸣钟前不能离开雨馆。`, 'utf8')));
  await fs.writeFile(path.join(bookA, '未确认候选.txt'), '　　银叶草稿石鸥只是候选。');
  await fs.writeFile(path.join(bookB, factNames[0]), '　　乙书蓝鲸不能出现在甲书。');
  const originals = await Promise.all(factNames.map(name => fs.readFile(path.join(bookA, name))));
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const choose = (folder: string) => app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
  const open = async (folder: string) => { await choose(folder); await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click(); await page.getByText(`已打开「${path.basename(folder)}」`, { exact: false }).waitFor(); };
  const search = async (query: string, corpus: 'canon' | 'discussion' = 'canon') => {
    await page.getByText('更多功能', { exact: true }).click(); await page.getByRole('button', { name: '知识检索', exact: true }).click(); await page.getByLabel('检索范围', { exact: true }).selectOption(corpus);
    await page.getByRole('button', { name: '重新读取来源', exact: true }).click(); await page.getByLabel('最多结果', { exact: true }).selectOption('20');
    await page.getByLabel('关键词', { exact: true }).fill(query); await page.getByRole('button', { name: '检索本书', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '检索完成' }).waitFor();
  };
  const useFirst = async () => { await page.getByRole('checkbox', { name: /^引用依据 / }).first().check(); await page.getByRole('button', { name: '用于本书写作与审稿', exact: true }).click(); };
  const waitTask = async (id: string, projectId: string) => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) { const task = (await page.evaluate(id => window.writer.aiTasks(id), projectId)).find(task => task.id === id); if (task && task.status !== 'running' && !['pending', 'running'].includes(task.autoReview?.status ?? '')) return task; await new Promise(resolve => setTimeout(resolve, 40)); }
    throw new Error('Mock citation task did not finish');
  };
  try {
    await open(bookA); const projectA = (await page.evaluate(() => window.writer.listProjects())).find(project => project.root === bookA)!;
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节', exact: true }).click(); await page.locator('.tiptap').fill('林夏坐在窗边。');
    await page.getByRole('button', { name: '保存 DOCX', exact: true }).click(); await page.getByText('DOCX 已保存到所选文件夹', { exact: true }).waitFor();
    const chapterName = (await fs.readdir(bookA)).find(name => name.endsWith('.docx'))!, chapterBytes = await fs.readFile(path.join(bookA, chapterName));
    await page.evaluate(async ({ id, names }) => {
      for (const name of names) { const preview = await window.writer.previewChapterConfirmation(id, name), snapshot = await window.writer.chapterConfirmations(id); await window.writer.confirmChapterVersion({ projectId: id, path: preview.path, sourceHash: preview.hash, expectedHash: snapshot.hash }); }
    }, { id: projectA.id, names: factNames });
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    for (const [index, model] of ['mock-citation-writer', 'mock-citation-reviewer'].entries()) {
      if (index) await page.getByRole('button', { name: '＋ 新增模型连接', exact: true }).click();
      await page.getByLabel('连接名称', { exact: true }).fill(index ? '引用审稿模型' : '引用写作模型');
      await page.getByLabel('API 基础地址', { exact: true }).fill(`http://127.0.0.1:${port}/v1`); await page.getByLabel('模型名称', { exact: true }).fill(model);
      await page.getByLabel('API 密钥', { exact: true }).fill('synthetic-citation-only');
      await page.getByRole('button', { name: '保存模型连接', exact: true }).click(); await page.getByText('模型连接已保存', { exact: true }).waitFor();
    }
    await search('银叶', 'discussion'); assert.equal(await page.getByRole('checkbox', { name: /^引用依据 / }).count(), 0, 'Draft corpus cannot become factual citations');
    await search('银叶'); const checks = page.getByRole('checkbox', { name: /^引用依据 / }); assert.equal(await checks.count(), 11);
    for (let i = 0; i < 10; i++) await checks.nth(i).check();
    if (await checks.nth(10).isEnabled()) await checks.nth(10).click();
    assert.equal(await checks.nth(10).isChecked(), false);
    assert.equal(await checks.evaluateAll(elements => elements.filter(element => (element as HTMLInputElement).checked).length), 10);
    for (let i = 1; i < 10; i++) await checks.nth(i).uncheck();
    await page.getByRole('button', { name: '写作空间', exact: true }).click();
    await page.getByText('更多功能', { exact: true }).click(); await page.getByRole('button', { name: '知识检索', exact: true }).click();
    assert.equal(await checks.first().isChecked(), true, 'A parent view render must preserve untransferred local selection');
    await page.getByRole('button', { name: '用于本书写作与审稿', exact: true }).click();
    assert.match(await page.locator('.ai-citation-selection').textContent() ?? '', /银叶|作者确认版本/); assert.equal(calls.length, 0, 'Selecting citations must not call a model');
    await page.getByLabel('写作模型', { exact: true }).selectOption({ label: '引用写作模型 · mock-citation-writer' });
    await page.getByLabel('审稿模型', { exact: true }).selectOption({ label: '引用审稿模型 · mock-citation-reviewer' });
    await page.getByRole('checkbox', { name: '生成后自动送审', exact: true }).check();
    await page.getByRole('button', { name: '生成正文候选', exact: true }).click();
    let parentId = ''; const deadline = Date.now() + 12000;
    while (!parentId && Date.now() < deadline) { parentId = (await page.evaluate(id => window.writer.aiTasks(id), projectA.id)).find(task => task.mode === 'write')?.id ?? ''; if (!parentId) await new Promise(resolve => setTimeout(resolve, 40)); }
    assert.ok(parentId); const parent = await waitTask(parentId, projectA.id); assert.equal(parent.status, 'complete'); assert.equal(parent.autoReview?.status, 'complete');
    assert.equal(parent.knowledgeCitations?.length, 1); assert.match(parent.citationFingerprint ?? '', /^[a-f0-9]{64}$/);
    assert.equal(calls.length, 2); assert.deepEqual(calls.map(call => call.model), ['mock-citation-writer', 'mock-citation-reviewer']);
    for (const call of calls) assert.match(call.messages[0].content, /鸣钟前不能离开雨馆/);
    const child = (await page.evaluate(id => window.writer.aiTasks(id), projectA.id)).find(task => task.id === parent.autoReview?.taskId)!;
    assert.deepEqual(child.knowledgeCitations, parent.knowledgeCitations); assert.equal(child.citationFingerprint, parent.citationFingerprint);
    assert.deepEqual(await fs.readFile(path.join(bookA, chapterName)), chapterBytes);
    await page.getByRole('button', { name: '查看自动审稿报告', exact: true }).waitFor();
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
    await fs.writeFile(path.resolve('.artifacts/knowledge-citations.png'), Buffer.from(png, 'base64'));
    await page.getByRole('button', { name: '清空检索依据', exact: true }).click();
    await page.getByRole('button', { name: '用审稿模型检查此候选', exact: true }).click();
    const reviewDeadline = Date.now() + 12000; while (calls.length < 3 && Date.now() < reviewDeadline) await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(calls.length, 3); assert.match(calls[2].messages[0].content, /鸣钟前不能离开雨馆/, 'Candidate review inherits its saved citations');
    // Disabling a confirmation invalidates completed candidate/report adoption.
    await page.evaluate(async ({ id, source }) => { const snapshot = await window.writer.chapterConfirmations(id); const entry = snapshot.value.entries.find(entry => entry.enabled && `chapters:${entry.sourcePath}` === source)!; await window.writer.disableChapterConfirmation(id, entry.id, snapshot.hash); }, { id: projectA.id, source: parent.knowledgeCitations![0].sourcePath });
    await assert.rejects(page.evaluate(({ id, task }) => window.writer.exportAI(id, task), { id: projectA.id, task: parent.id }), /引用|依据|确认|更新|变化/);
    assert.deepEqual(await fs.readFile(path.join(bookA, chapterName)), chapterBytes);
    // A stale selected snapshot is rejected before the next network call.
    await search('银叶'); await useFirst();
    const currentRef = (await page.evaluate(async id => { const result = await window.writer.searchKnowledge({ projectId: id, requestId: crypto.randomUUID(), corpus: 'canon', query: '银叶', topK: 20 }); return result.hits[0]; }, projectA.id));
    await fs.writeFile(path.join(bookA, currentRef.sourcePath.slice('chapters:'.length)), '　　外部已经改写这一条规则。');
    await page.getByRole('checkbox', { name: '生成后自动送审', exact: true }).uncheck(); await page.getByRole('button', { name: '生成正文候选', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /引用|依据|确认|更新|变化/ }).first().waitFor(); assert.equal(calls.length, 3);
    await page.getByRole('button', { name: '写作空间', exact: true }).click(); await open(bookB);
    await page.getByRole('button', { name: 'AI', exact: true }).click(); await page.getByRole('button', { name: '打开 AI 写作与审稿', exact: true }).click();
    assert.doesNotMatch(await page.locator('.ai-citation-selection').textContent() ?? '', /银叶|依据0/);
    assert.deepEqual(await fs.readFile(path.join(bookA, chapterName)), chapterBytes);
    for (const [i, name] of factNames.entries()) if (`chapters:${name}` !== currentRef.sourcePath) assert.deepEqual(await fs.readFile(path.join(bookA, name)), originals[i]);
    assert.deepEqual(errors, []);
    console.log('Citation desktop passed: explicit canon-only 10-item selection, no automatic model calls, actual mock write/automatic and candidate review forwarding, persisted proof, stale confirmation/export and source/network gate, two-book isolation and unchanged original DOCX.');
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
