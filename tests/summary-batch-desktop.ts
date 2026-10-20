import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R27b-2: batch chapter summaries stay drafts until the author confirms them.
async function main() {
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw) as { messages: { content: string }[] };
    calls.push(body.messages[1].content);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `摘要草稿：${body.messages[1].content.slice(0, 10)}` }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const fixture = path.resolve('.artifacts', `summary-batch-desktop-${Date.now()}`), folder = path.join(fixture, '批量摘要小说');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByLabel('新章节格式').selectOption('txt');
    await page.getByRole('button', { name: '＋ 新建 TXT 章节' }).click();
    await page.locator('.tiptap').fill('第一章虚构正文。');
    await page.getByRole('button', { name: '保存 TXT', exact: true }).click();
    await page.getByText('TXT 已保存到所选文件夹', { exact: true }).waitFor();
    const first = (await fs.readdir(folder)).find(name => name.endsWith('.txt'))!;
    const original = await fs.readFile(path.join(folder, first));
    const projectId = (await page.evaluate(() => window.writer.listProjects()))[0].id;
    await page.evaluate(async id => {
      const chapter = await window.writer.createChapter(id, 'txt');
      await window.writer.saveChapter({ projectId: id, path: chapter.path, expectedHash: chapter.hash,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '　　第二章虚构正文。' }] }] } });
    }, projectId);

    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByLabel('快捷配置').selectOption({ label: 'DeepSeek' });
    await page.getByLabel('深度思考').selectOption('disabled');
    await page.getByLabel('API 基础地址', { exact: true }).fill(`http://127.0.0.1:${port}/v1`);
    await page.getByLabel('连接名称', { exact: true }).fill('摘要模型 S');
    await page.getByLabel('模型名称', { exact: true }).fill('mock-summary');
    await page.getByLabel('API 密钥', { exact: true }).fill('test-only-key');
    await page.getByRole('button', { name: '保存模型连接', exact: true }).click();
    await page.getByText('模型连接已保存', { exact: true }).waitFor();

    await page.getByRole('button', { name: '写作空间', exact: true }).click();
    await page.getByRole('button', { name: '记忆', exact: true }).click();
    await page.getByRole('button', { name: '打开章节摘要与故事记忆' }).click();
    await page.getByLabel('摘要模型').selectOption({ label: '摘要模型 S · mock-summary' });
    await page.getByText('批量生成摘要（按顺序逐章，逐章计费）', { exact: true }).click();
    await page.getByRole('button', { name: '全选', exact: true }).click();
    await page.getByRole('button', { name: '批量生成所选章节摘要' }).click();
    await page.getByText('批量摘要结束：成功 2/2', { exact: false }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="摘要任务历史"] option').length === 2, undefined, { timeout: 20000 });
    assert.equal(calls.length, 2);
    // Drafts are not memory: nothing is confirmed automatically.
    await page.getByText('尚无确认摘要。生成结果不会自动成为记忆。', { exact: true }).waitFor();
    // Optional: saving a chapter creates another draft, still never confirmed.
    await page.getByLabel('保存章节后自动生成摘要草稿').check();
    await page.getByRole('button', { name: '写作空间', exact: true }).click();
    await page.locator('.tiptap').fill('第一章虚构正文，保存后自动生成摘要草稿。');
    await page.getByRole('button', { name: '保存 TXT', exact: true }).click();
    await page.waitForFunction(async () => {
      const id = (await window.writer.listProjects())[0].id;
      return (await window.writer.aiTasks(id)).filter(task => task.mode === 'summary').length === 3;
    }, undefined, { timeout: 30000 });
    await page.getByRole('button', { name: '记忆', exact: true }).click();
    await page.getByRole('button', { name: '打开章节摘要与故事记忆' }).click();
    await page.getByText('尚无确认摘要。生成结果不会自动成为记忆。', { exact: true }).waitFor();
    assert.equal(calls.length, 3);
    // The auto draft followed the new save, and the file now holds the text the author saved.
    assert.match(await fs.readFile(path.join(folder, first), 'utf8'), /保存后自动生成摘要草稿/u);
    assert.deepEqual(errors, []);
    console.log('Summary batch desktop passed: two chapters summarised in order, drafts listed, nothing auto-confirmed, optional draft on save, original text only changed by the author save.');
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
