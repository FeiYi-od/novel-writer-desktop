import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import type { AITask, RichNode } from '../src/shared/contracts';

async function main() {
  const fixture = path.resolve('.artifacts', `rich-review-desktop-${Date.now()}`);
  const bookA = path.join(fixture, '格式审稿雨馆甲'), bookB = path.join(fixture, '格式审稿海港乙');
  await Promise.all([fs.mkdir(bookA, { recursive: true }), fs.mkdir(bookB, { recursive: true })]);
  await fs.writeFile(path.join(bookB, '乙书正文.txt'), '　　乙书蓝鲸留在港口。');
  const originalB = await fs.readFile(path.join(bookB, '乙书正文.txt'));
  const calls: { model: string; messages: { content: string }[] }[] = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); calls.push(body);
    const isReview = body.messages[0].content.includes('只输出 JSON');
    const isOriginal = body.messages[1].content.includes('雨馆第一章');
    const output = isReview ? JSON.stringify({
      summary: isOriginal ? '原章格式审稿：只修改两处错字。' : '候选格式审稿：只修改两处错字。',
      issues: [
        { category: '错别字', quote: '雨生', replacement: '雨声', reason: '虚构文本中此处表示声音。', evidence: '' },
        { category: '错别字', quote: '信只', replacement: '信纸', reason: '虚构文本中此处表示纸张。', evidence: '' }
      ]
    }) : '林夏听见雨生。\n她收起信只。';
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: output }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const open = async (folder: string) => {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByText(`已打开「${path.basename(folder)}」`, { exact: false }).waitFor();
    return (await page.evaluate(() => window.writer.listProjects())).find(project => project.root === folder)!;
  };
  const showAI = async () => {
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    await page.getByRole('button', { name: '打开 AI 写作与审稿', exact: true }).click();
  };
  const tasks = (projectId: string) => page.evaluate(id => window.writer.aiTasks(id), projectId);
  const waitNewTask = async (projectId: string, before: Set<string>, mode: AITask['mode']) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const task = (await tasks(projectId)).find(task => task.mode === mode && !before.has(task.id) && task.status !== 'running');
      if (task) { assert.equal(task.status, 'complete', task.error); return task; }
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(`No completed ${mode} task: ${JSON.stringify(await tasks(projectId))}`);
  };
  const chapterButton = (name: string) => page.locator('.chapter-list button').filter({ hasText: path.basename(name) });
  const exportSelected = async (folder: string) => {
    const before = new Set((await fs.readdir(folder)).filter(name => name.endsWith('.docx')));
    await page.getByLabel('采纳建议 issue-1', { exact: true }).check();
    await page.getByLabel('采纳建议 issue-2', { exact: true }).check();
    await page.getByText('预览选中修改后的全文', { exact: true }).click();
    const preview = await page.getByLabel('审稿修订预览', { exact: true }).textContent();
    await page.getByRole('button', { name: '采纳选中建议并另存 DOCX', exact: true }).click();
    await page.getByText('已另存修订稿', { exact: false }).waitFor();
    const added = (await fs.readdir(folder)).filter(name => name.endsWith('.docx') && !before.has(name));
    assert.equal(added.length, 1); return { name: added[0], preview };
  };
  const rich: RichNode = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '雨馆第一章' }] },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '雨夜便笺' }] },
    { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '窗边一节' }] },
    { type: 'paragraph', content: [
      { type: 'text', text: '林夏听见', marks: [{ type: 'bold' }] },
      { type: 'text', text: '雨生', marks: [{ type: 'italic' }] },
      { type: 'text', text: '。未选粗体', marks: [{ type: 'bold' }] },
      { type: 'text', text: '与未选斜体', marks: [{ type: 'italic' }] },
      { type: 'text', text: '。' }, { type: 'hardBreak', marks: [{ type: 'bold' }, { type: 'italic' }] }, { type: 'text', text: '灯火依旧。' }
    ] },
    { type: 'paragraph', content: [] },
    { type: 'paragraph', content: [
      { type: 'text', text: '她收起', marks: [{ type: 'italic' }] },
      { type: 'text', text: '信', marks: [{ type: 'bold' }] },
      { type: 'text', text: '只，静坐到天明。' }
    ] },
    { type: 'paragraph', content: [{ type: 'text', text: '同行者没有出门。' }] }
  ] };
  try {
    const projectA = await open(bookA);
    const source = await page.evaluate(({ id, content }) => window.writer.copyChapter(id, content), { id: projectA.id, content: rich });
    const originalA = await fs.readFile(path.join(bookA, source.path));
    const profile = await page.evaluate(async baseUrl => {
      const snapshot = await window.writer.aiConnections();
      const next = await window.writer.saveAIConnection({ name: '虚构格式审稿模型', model: 'mock-rich-review', baseUrl, adapter: 'generic', thinking: 'default', timeoutSeconds: 60, contextWindow: 32768, maxOutputTokens: 1200, tokenParameter: 'max_tokens', apiKey: 'fictional-rich-review-key' }, snapshot.hash);
      return next.connections.at(-1)!;
    }, endpoint);
    await page.reload(); await open(bookA); await chapterButton(source.path).click();
    assert.equal(await page.locator('.tiptap h1').textContent(), '雨馆第一章');
    assert.equal(await page.locator('.tiptap h2').textContent(), '雨夜便笺');
    assert.equal(await page.locator('.tiptap h3').textContent(), '窗边一节');
    assert.equal(await page.getByRole('button', { name: '保存 DOCX', exact: true }).isDisabled(), true);
    await showAI();
    await page.getByLabel('写作模型', { exact: true }).selectOption(profile.id);
    await page.getByLabel('审稿模型', { exact: true }).selectOption(profile.id);
    await page.getByLabel('结构化审稿', { exact: true }).check();
    const beforeReview = new Set((await tasks(projectA.id)).map(task => task.id));
    await page.getByRole('button', { name: '审阅已保存章节', exact: true }).click();
    const report = await waitNewTask(projectA.id, beforeReview, 'review');
    await page.getByText('原章格式审稿：只修改两处错字。', { exact: true }).waitFor();
    assert.equal(report.reviewTaskId, undefined); assert.match(report.reviewDocumentHash ?? '', /^[a-f0-9]{64}$/);
    assert.equal(report.sourceHash, source.hash); assert.equal(report.projectId, projectA.id);
    assert.match(calls[0].messages[1].content, /雨馆第一章/); assert.match(calls[0].messages[1].content, /信只/);
    assert.deepEqual(await fs.readFile(path.join(bookA, source.path)), originalA);
    const { name: revisionName, preview } = await exportSelected(bookA);
    assert.equal(preview, '雨馆第一章\n\n雨夜便笺\n\n窗边一节\n\n　　林夏听见雨声。未选粗体与未选斜体。\n灯火依旧。\n\n　　\n\n　　她收起信纸，静坐到天明。\n\n　　同行者没有出门。');
    const reopened = await page.evaluate(({ id, name }) => window.writer.readChapter(id, name), { id: projectA.id, name: revisionName });
    assert.equal(reopened.managed, true); assert.notEqual(typeof reopened.content, 'string');
    if (typeof reopened.content === 'string') throw new Error('Revision lost its supported rich structure');
    const blocks = reopened.content.content!;
    assert.equal(blocks.length, 7); assert.deepEqual(blocks.slice(0, 3).map(block => [block.type, block.attrs?.level]), [['heading', 1], ['heading', 2], ['heading', 3]]);
    assert.deepEqual(blocks[4], { type: 'paragraph', content: [{ type: 'text', text: '　　' }] });
    assert.ok(blocks[3].content!.some(run => run.type === 'hardBreak' && run.marks?.some(mark => mark.type === 'bold') && run.marks?.some(mark => mark.type === 'italic')));
    assert.ok(blocks[3].content!.some(run => run.text?.includes('雨声') && run.marks?.some(mark => mark.type === 'italic')));
    assert.ok(blocks[5].content!.some(run => run.text?.includes('信纸') && run.marks?.some(mark => mark.type === 'bold')), 'Cross-run replacement inherits the first matched glyph style');
    assert.ok(blocks[3].content!.some(run => run.text?.includes('未选粗体') && run.marks?.some(mark => mark.type === 'bold')));
    assert.ok(blocks[3].content!.some(run => run.text?.includes('未选斜体') && run.marks?.some(mark => mark.type === 'italic')));
    assert.equal(blocks[6].content![0].text, '　　同行者没有出门。');
    for (const block of blocks.filter(block => block.type === 'paragraph')) {
      const firstText = block.content![0].text ?? '';
      assert.ok(firstText === '　　' || /^　　[^　]/u.test(firstText), 'Body paragraphs contain exactly two real U+3000 prefix characters');
    }
    const zip = await JSZip.loadAsync(await fs.readFile(path.join(bookA, revisionName)));
    const xml = await zip.file('word/document.xml')!.async('string'), styles = await zip.file('word/styles.xml')!.async('string');
    for (const level of [1, 2, 3]) assert.match(xml, new RegExp(`<w:pStyle w:val="Heading${level}"`));
    assert.match(xml, /<w:br\s*\/>/); assert.match(styles, /宋体/); assert.match(styles, /<w:sz w:val="21"/);
    assert.match(xml, /　　林夏听见/); assert.match(xml, /　　同行者没有出门。/);
    const xmlParagraphs = xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) ?? [];
    assert.equal(xmlParagraphs.length, 7);
    assert.equal((xmlParagraphs[4].match(/<w:t(?:\s[^>]*)?>(.*?)<\/w:t>/g) ?? []).map(run => run.replace(/<[^>]*>/g, '')).join(''), '　　', 'The empty paragraph survives in the actual DOCX bytes');
    const runs = xml.match(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g) ?? [];
    assert.ok(runs.some(run => run.includes('雨声') && /<w:i(?:\s|\/|>)/.test(run)));
    assert.ok(runs.some(run => run.includes('信纸') && /<w:b(?:\s|\/|>)/.test(run)));
    assert.ok(runs.some(run => run.includes('未选粗体') && /<w:b(?:\s|\/|>)/.test(run)));
    assert.ok(runs.some(run => run.includes('未选斜体') && /<w:i(?:\s|\/|>)/.test(run)));
    assert.deepEqual(await fs.readFile(path.join(bookA, source.path)), originalA);

    // Show the real reopened DOCX in the editor; screenshot must include its heading and styled body.
    await page.getByRole('button', { name: '写作空间', exact: true }).click(); await chapterButton(revisionName).click();
    await page.locator('.tiptap h1').filter({ hasText: '雨馆第一章' }).waitFor();
    assert.ok((await page.locator('.tiptap em').allTextContents()).some(text => text.includes('雨声')));
    assert.ok((await page.locator('.tiptap strong').allTextContents()).some(text => text.includes('信纸')));
    await page.locator('.paper-scroll').evaluate(element => { element.scrollTop = 0; });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
    await fs.writeFile(path.resolve('.artifacts/rich-review.png'), Buffer.from(png, 'base64'));

    // Hash-addressed editing metadata is mutable independently of original bytes. Old reports must reject that change too.
    const stateFile = path.join(bookA, '小说资料', 'documents', `${source.hash}.json`), stateBytes = await fs.readFile(stateFile);
    const changedState = JSON.parse(stateBytes.toString('utf8')); changedState.content.content[3].content[0].marks = [{ type: 'italic' }];
    const countBeforeReject = (await fs.readdir(bookA)).filter(name => name.endsWith('.docx')).length;
    try {
      await fs.writeFile(stateFile, JSON.stringify(changedState));
      const message = await page.evaluate(async ({ id, taskId }) => { try { await window.writer.exportReviewEdits(id, taskId, ['issue-1']); return ''; } catch (error) { return String(error); } }, { id: projectA.id, taskId: report.id });
      assert.match(message, /格式|结构|版本|变化|原文/);
      assert.equal((await fs.readdir(bookA)).filter(name => name.endsWith('.docx')).length, countBeforeReject);
      assert.deepEqual(await fs.readFile(path.join(bookA, source.path)), originalA);
    } finally { await fs.writeFile(stateFile, stateBytes); }
    const projectB = await open(bookB);
    const crossBookError = await page.evaluate(async ({ id, taskId }) => { try { await window.writer.exportReviewEdits(id, taskId, ['issue-1']); return ''; } catch (error) { return String(error); } }, { id: projectB.id, taskId: report.id });
    assert.ok(crossBookError); assert.equal((await fs.readdir(bookB)).filter(name => name.endsWith('.docx')).length, 0);
    assert.deepEqual(await fs.readFile(path.join(bookB, '乙书正文.txt')), originalB);

    // Candidate reports retain their basic paragraph behavior and cannot inherit the original chapter's headings or marks.
    await open(bookA); await chapterButton(source.path).click(); await showAI();
    const beforeWrite = new Set((await tasks(projectA.id)).map(task => task.id));
    await page.getByRole('button', { name: '生成正文候选', exact: true }).click();
    const candidate = await waitNewTask(projectA.id, beforeWrite, 'write');
    await page.getByRole('heading', { name: '正文候选 · 已完成', exact: true }).waitFor();
    const beforeCandidateReview = new Set((await tasks(projectA.id)).map(task => task.id));
    await page.getByRole('button', { name: '用审稿模型检查此候选', exact: true }).click();
    const candidateReport = await waitNewTask(projectA.id, beforeCandidateReview, 'review');
    assert.equal(candidateReport.reviewTaskId, candidate.id); assert.equal(candidateReport.reviewDocumentHash, undefined);
    await page.getByText('候选格式审稿：只修改两处错字。', { exact: true }).waitFor();
    const { name: basicName } = await exportSelected(bookA);
    const basic = await page.evaluate(({ id, name }) => window.writer.readChapter(id, name), { id: projectA.id, name: basicName });
    if (typeof basic.content === 'string') throw new Error('Candidate revision is not a managed DOCX');
    assert.equal(basic.content.content!.length, 2);
    assert.ok(basic.content.content!.every(block => block.type === 'paragraph' && block.content!.every(run => !run.marks?.length)));
    assert.deepEqual(basic.content.content!.map(block => block.content!.map(run => run.text ?? '').join('')), ['　　林夏听见雨声。', '　　她收起信纸。']);
    assert.equal(calls.length, 3); assert.deepEqual(await fs.readFile(path.join(bookA, source.path)), originalA);
    assert.deepEqual(errors, []);
    console.log('Rich review desktop passed: UI manual structured review, two anchored edits, rich DOCX headings/bold/italic/hard break/empty paragraph and untouched text, actual DOCX XML/font/U3000 verification, unchanged original bytes, same-byte structure drift and cross-book rejection, and candidate revisions retaining basic paragraph behavior.');
  } catch (error) {
    await fs.writeFile(path.join(fixture, 'failure-calls.json'), JSON.stringify(calls, null, 2));
    await fs.writeFile(path.join(fixture, 'failure-ui.txt'), await page.locator('body').innerText().catch(() => 'No live test page'));
    throw error;
  } finally {
    await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {});
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
