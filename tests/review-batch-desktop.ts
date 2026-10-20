import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// 16d-1: manual review of a saved chapter with several review models, each producing its own report.
async function main() {
  const calls: { model: string; text: string }[] = []; let active = 0, maximum = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw) as { model: string; messages: { content: string }[] };
    active++; maximum = Math.max(maximum, active); calls.push({ model: body.model, text: body.messages[1].content });
    const issue = body.model === 'mock-r2'
      ? { category: '语病', quote: '信纸', replacement: '信笺', reason: '措辞建议', evidence: '' }
      : { category: '错别字', quote: '推开们', replacement: '推开门', reason: '门字误写', evidence: '' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    setTimeout(() => { active--; if (!res.destroyed) res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify({ summary: `${body.model} 报告`, issues: [issue] }) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`); }, 120);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const fixture = path.resolve('.artifacts', `review-batch-desktop-${Date.now()}`), folder = path.join(fixture, '批量审稿小说');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).click();
    await page.locator('.tiptap').fill('林夏推开们。\n她收起了信纸。');
    await page.getByRole('button', { name: '保存 DOCX', exact: true }).click();
    await page.getByText('DOCX 已保存到所选文件夹', { exact: true }).waitFor();
    const originalName = (await fs.readdir(folder)).find(name => name.endsWith('.docx'))!;
    const original = await fs.readFile(path.join(folder, originalName));

    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    const connect = async (name: string, model: string, first: boolean) => {
      if (!first) await page.getByRole('button', { name: '＋ 新增模型连接' }).click();
      await page.getByLabel('快捷配置').selectOption({ label: 'DeepSeek' });
      await page.getByLabel('深度思考').selectOption('disabled');
      await page.getByLabel('API 基础地址', { exact: true }).fill(`http://127.0.0.1:${port}/v1`);
      await page.getByLabel('连接名称', { exact: true }).fill(name);
      await page.getByLabel('模型名称', { exact: true }).fill(model);
      await page.getByLabel('API 密钥', { exact: true }).fill('test-only-key');
      await page.getByRole('button', { name: '保存模型连接', exact: true }).click();
      await page.getByText('模型连接已保存', { exact: true }).waitFor();
    };
    await connect('审稿一', 'mock-r1', true);
    await connect('审稿二', 'mock-r2', false);

    await page.getByRole('button', { name: '写作空间', exact: true }).click();
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    await page.getByRole('button', { name: '打开 AI 写作与审稿' }).click();
    await page.getByLabel('审稿模型', { exact: true }).selectOption({ label: '审稿一 · mock-r1' });
    await page.getByRole('button', { name: '添加审稿模型' }).click();
    await page.getByLabel('追加审稿模型 2', { exact: true }).selectOption({ label: '审稿二 · mock-r2' });
    await page.getByLabel('结构化审稿').check();
    await page.getByLabel('手动审稿使用全部审稿模型').check();
    await page.getByRole('button', { name: '审阅已保存章节', exact: true }).click();
    await page.getByText('已按 2 个审稿模型依次审阅已保存章节', { exact: false }).waitFor();
    await page.getByRole('heading', { name: '审稿报告 · 已完成' }).waitFor();

    // Two independent reports, executed in order, without overlapping requests.
    assert.deepEqual(calls.map(call => call.model), ['mock-r1', 'mock-r2']);
    assert.equal(maximum, 1, '批量审稿不能并发');
    assert.ok(calls.every(call => call.text.includes('林夏推开们')));
    await page.getByText(/同版本多报告合并 · 2 份报告 \/ 2 条意见/u).waitFor();
    const merged = await page.locator('.ai-merged').innerText();
    assert.match(merged, /审稿一 \/ mock-r1/u); assert.match(merged, /审稿二 \/ mock-r2/u);
    const reports = await page.locator('.ai-history button').filter({ hasText: '审稿报告' }).count();
    assert.equal(reports, 2);
    assert.deepEqual(await fs.readFile(path.join(folder, originalName)), original);
    assert.deepEqual(errors, []);
    console.log('Review batch desktop passed: two review models in order, two independent reports, merged view, no overlap, original bytes unchanged.');
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
