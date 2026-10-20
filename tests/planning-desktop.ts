import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { planningHeadings } from '../src/core/planning';
import { materialTemplate } from '../src/core/material-conversion';
import { parseCharactersMarkdown, parseNotesMarkdown } from '../src/main/markdown-materials';
async function main() {
  const calls: any[] = []; const outline = planningHeadings.outline.map(h => `## ${h}\n\n月光列车寻找失落的车站。`).join('\n\n');
  const server = createServer(async (req, res) => { let raw = ''; for await (const part of req) raw += part; const body = JSON.parse(raw); calls.push(body);
    const system = body.messages[0].content;
    const result = system.includes('协助作者设计世界观') ? materialTemplate('world', '月光是列车唯一能源。') : system.includes('协助作者设计角色卡') ? materialTemplate('character', '寻找姐姐的学生。', '林夏') : system.includes('独立审稿人') ? '已检查月光列车大纲。' : outline;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: result }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const fixture = path.resolve('.artifacts', `planning-desktop-${Date.now()}`), folder = path.join(fixture, '筹备小说甲'), local = path.join(fixture, 'app-data'); await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url); const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: local } });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const choose = (selected: string) => app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, selected);
  const save = async () => { await page.getByRole('button', { name: '保存筹备资料', exact: true }).click(); await page.getByText('筹备提示词与草稿已保存', { exact: true }).waitFor(); };
  const generate = async () => { await page.getByRole('button', { name: '生成筹备草稿', exact: true }).click(); await page.getByRole('heading', { name: '模型结果 · 已完成', exact: true }).waitFor(); await page.getByRole('button', { name: '放入可编辑草稿', exact: true }).click(); await save(); };
  try {
    await choose(folder); await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByText('已打开「筹备小说甲」· 0 个正文文件（DOCX / TXT）', { exact: true }).waitFor();
    const projectId = JSON.parse(await fs.readFile(path.join(folder, '小说资料/project.json'), 'utf8')).id;
    const materials = path.join(local, '创作资料', projectId);
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).click();
    await page.getByText('已新建 DOCX · 宋体五号', { exact: true }).waitFor();
    const manuscriptFile = path.join(folder, (await fs.readdir(folder)).find(n => n.endsWith('.docx'))!); const manuscript = await fs.readFile(manuscriptFile);
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByLabel('连接名称', { exact: true }).fill('筹备测试模型'); await page.getByLabel('API 基础地址', { exact: true }).fill(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`); await page.getByLabel('模型名称', { exact: true }).fill('mock');
    await page.getByRole('button', { name: '保存模型连接', exact: true }).click(); await page.getByText('模型连接已保存', { exact: true }).waitFor();
    await page.getByRole('button', { name: '创作筹备', exact: true }).click();
    await page.getByLabel('筹备提示词').fill('请设计少年成长故事，主线必须围绕寻找失落车站。'); await page.getByLabel('筹备构想').fill('月光列车上的学生寻找姐姐。');
    await page.getByLabel('筹备模型').selectOption({ label: '筹备测试模型 · mock' }); await generate();
    let data = await page.evaluate(id => window.writer.readPlanning(id), projectId); assert.equal(data.value.outline, ''); assert.match(data.value.drafts.outline, /月光列车/);
    await page.getByRole('button', { name: '确认采用为本书大纲' }).click(); await page.getByText('已确认采用故事大纲，后续写作与审稿将使用它', { exact: true }).waitFor();
    data = await page.evaluate(id => window.writer.readPlanning(id), projectId); assert.equal(data.value.outline, outline);
    // Confirmed outline must be present in real review HTTP, without altering DOCX.
    const review = await page.evaluate(async id => { const doc = (await window.writer.chapters(id))[0]; const source = await window.writer.readChapter(id, doc.path); const settings = await window.writer.aiConnections(); return window.writer.startAI({ projectId: id, connectionId: settings.connections[0].id, mode: 'review', chapterPath: source.path, sourceHash: source.hash, instruction: '检查大纲一致性' }); }, projectId);
    await page.waitForFunction(async ({ projectId, taskId }) => (await window.writer.aiTasks(projectId)).some(t => t.id === taskId && t.status === 'complete'), { projectId, taskId: review.id });
    assert.match(calls.at(-1).messages[0].content, /已确认故事大纲/);
    await page.locator('.planning-tabs').getByRole('button', { name: '世界观', exact: true }).click(); await page.getByLabel('筹备构想').fill('围绕月光能源设计世界观。'); await generate();
    await page.getByRole('button', { name: '确认追加到本书世界观' }).click(); await page.getByText('已确认追加世界观', { exact: true }).waitFor();
    assert.match(parseNotesMarkdown(await fs.readFile(path.join(materials, '创作笔记.md'), 'utf8'), projectId).world, /唯一能源/);
    await page.locator('.planning-tabs').getByRole('button', { name: '角色卡', exact: true }).click(); await page.getByLabel('筹备构想').fill('设计主角林夏。'); await generate();
    await page.getByRole('button', { name: '确认新增角色卡' }).click(); await page.getByText('已确认新增角色，请到角色库启用', { exact: true }).waitFor();
    const cards = parseCharactersMarkdown(await fs.readFile(path.join(materials, '人物卡.md'), 'utf8'), projectId); assert.equal(cards.cards[0].name, '林夏'); assert.equal(cards.cards[0].enabled, false);
    assert.deepEqual(await fs.readFile(manuscriptFile), manuscript);
    await page.locator('.planning-page').evaluate(element => { element.scrollTop = 0; });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')); await fs.writeFile(path.resolve('.artifacts/planning.png'), Buffer.from(png, 'base64'));
    // Minimum supported window width: every top-level action stays inside the viewport.
    await page.setViewportSize({ width: 1000, height: 720 });
    await page.waitForFunction(() => window.innerWidth <= 1000);
    assert.equal(await page.locator('.topbar').evaluate(el => el.scrollWidth > el.clientWidth), false);
    const other = path.join(fixture, '筹备小说乙'); await fs.mkdir(other); await choose(other); await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click(); await page.getByRole('button', { name: '创作筹备', exact: true }).click();
    assert.equal(await page.getByLabel('筹备构想').inputValue(), ''); assert.equal(await page.getByLabel('筹备草稿').inputValue(), '');
    await choose(folder); await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click(); await page.getByRole('button', { name: '创作筹备', exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('[aria-label="筹备提示词"]') as HTMLTextAreaElement).value.includes('失落车站'));
    assert.deepEqual(errors, []); console.log('Planning desktop passed: custom prompts, outline/world/character generation and confirmation, review context, DOCX preservation, reload, book isolation, 1000px navigation.');
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
