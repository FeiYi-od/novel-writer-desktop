import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
async function main() {
  const calls: any[] = [];
  const server = createServer(async (req, res) => { let raw = ''; for await (const part of req) raw += part; const body = JSON.parse(raw); calls.push(body);
    const text = body.messages[0].content.includes('文风分析助手') ? JSON.stringify({ rules: ['对白短而清晰，以人物反应推动场景。', '用简短心理描写连接对白。', '场景转折用小动作提示。'], limitations: ['样本没有战斗场景。'] }) : '林夏站起身，望向窗外。';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const fixture = path.resolve('.artifacts', `style-desktop-${Date.now()}`), folder = path.join(fixture, '文风小说甲'), local = path.join(fixture, 'app-data'); await fs.mkdir(folder, { recursive: true });
  const reference = path.join(fixture, '轻小说参考.txt'); await fs.writeFile(reference, '参考角色白鸟说：“早安。”他望着学园的窗口，抬手整理袖口。\n'.repeat(1000), 'utf8');
  const require = createRequire(import.meta.url); const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: local } });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const choose = (selected: string) => app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, selected);
  try {
    await choose(folder); await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click(); await page.getByText('已打开「文风小说甲」· 0 个正文文件（DOCX / TXT）', { exact: true }).waitFor();
    const projectId = (await page.evaluate(() => window.writer.listProjects()))[0].id;
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).click(); await page.getByText('已新建 DOCX · 宋体五号', { exact: true }).waitFor();
    await page.locator('.tiptap').fill('本书林夏坐在窗边。'); await page.getByRole('button', { name: '保存 DOCX', exact: true }).click(); await page.getByText('DOCX 已保存到所选文件夹', { exact: true }).waitFor();
    const doc = (await fs.readdir(folder)).find(n => n.endsWith('.docx'))!; const original = await fs.readFile(path.join(folder, doc));
    await page.getByRole('button', { name: '模型设置', exact: true }).click(); await page.getByLabel('连接名称', { exact: true }).fill('文风分析模型');
    await page.getByLabel('API 基础地址', { exact: true }).fill(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`); await page.getByLabel('模型名称', { exact: true }).fill('mock-style');
    await page.getByRole('button', { name: '保存模型连接', exact: true }).click(); await page.getByText('模型连接已保存', { exact: true }).waitFor();
    await page.getByRole('button', { name: '文风研习室', exact: true }).click(); await choose(reference); await page.getByRole('button', { name: '＋ 导入文本', exact: true }).click();
    await page.locator('.source-list').getByRole('checkbox').check(); await page.getByLabel('文风名称', { exact: true }).fill('模型轻小说');
    await page.getByLabel('文风分析模型').selectOption({ label: '文风分析模型 · mock-style' }); await page.getByRole('button', { name: '用模型分析选中语料', exact: true }).click();
    await page.getByRole('button', { name: '放入文风确认稿', exact: true }).click();
    await page.getByText('将使用分析时的名称「模型轻小说」保存。', { exact: true }).waitFor();
    assert.equal((await page.evaluate(id => window.writer.readBook(id), projectId)).value.styles.length, 0);
    await page.getByLabel('文风规则确认稿').fill('对白短而清晰，心理描写只写必要反应。\n故事事实严格服从本书设定。');
    await page.getByRole('button', { name: '确认保存模型文风', exact: true }).click(); await page.getByText('已确认保存模型文风，点击用于本书后生效', { exact: true }).waitFor();
    const book = await page.evaluate(id => window.writer.readBook(id), projectId); assert.equal(book.value.styles[0].method, 'model-analysis-v1'); assert.equal(book.value.activeStyleId, ''); assert.equal(book.value.styles[0].analysis?.sampled, true);
    await page.locator('.style-card').getByRole('button', { name: '用于本书', exact: true }).click(); await page.getByText('本书使用中', { exact: true }).waitFor();
    await page.locator('.style-learning-panel').scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')); await fs.writeFile(path.resolve('.artifacts/style-learning.png'), Buffer.from(png, 'base64'));
    await page.getByRole('button', { name: '写作空间', exact: true }).click(); await page.getByRole('button', { name: 'AI', exact: true }).click(); await page.getByRole('button', { name: '打开 AI 写作与审稿', exact: true }).click();
    await page.getByLabel('写作模型', { exact: true }).selectOption({ label: '文风分析模型 · mock-style' }); await page.getByRole('button', { name: '生成正文候选', exact: true }).click(); await page.getByRole('heading', { name: '正文候选 · 已完成', exact: true }).waitFor();
    assert.match(calls.at(-1).messages[0].content, /心理描写只写必要反应/); assert.doesNotMatch(JSON.stringify(calls.at(-1)), /白鸟/); assert.deepEqual(await fs.readFile(path.join(folder, doc)), original);
    const other = path.join(fixture, '文风小说乙'); await fs.mkdir(other); await choose(other); await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click(); await page.getByRole('button', { name: '文风研习室', exact: true }).click();
    await page.getByText('让表达拥有不同的气质', { exact: true }).waitFor(); assert.equal(await page.locator('.style-card').count(), 0);
    assert.deepEqual(errors, []); console.log('Style desktop passed: sampled model analysis, edited confirmation, Markdown method/provenance, selected writing rules, original/source fact isolation and book isolation.');
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
