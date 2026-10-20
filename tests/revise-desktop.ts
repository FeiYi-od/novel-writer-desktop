import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import mammoth from 'mammoth';

// 16d-2: author-selected review issues drive a separate revision model; the original
// chapter is never modified and no automatic re-review happens.
async function main() {
  const calls: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); calls.push(body);
    const structured = body.messages[0].content.includes('只输出 JSON');
    const text = body.model === 'mock-reviser' ? '林夏推开门。\n雨停了。'
      : structured ? JSON.stringify({ summary: '发现一个可定位错字', issues: [{ category: '错别字', quote: '推开们', replacement: '推开门', reason: '门字误写', evidence: '' }] })
        : '审稿完成：未发现其他问题。';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const fixture = path.resolve('.artifacts', `revise-desktop-${Date.now()}`), folder = path.join(fixture, '修订测试小说');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000); const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).click();
    await page.locator('.tiptap').fill('林夏推开们。\n雨停了。');
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
    await connect('审稿模型 R', 'mock-reviewer', true);
    await connect('修订模型 D', 'mock-reviser', false);
    assert.ok(!(await fs.readFile(path.join(fixture, 'app-data', 'ai-connections.json'), 'utf8')).includes('test-only-key'));

    await page.getByRole('button', { name: '写作空间', exact: true }).click();
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    await page.getByRole('button', { name: '打开 AI 写作与审稿' }).click();
    await page.getByLabel('审稿模型', { exact: true }).selectOption({ label: '审稿模型 R · mock-reviewer' });
    await page.getByLabel('修订模型', { exact: true }).selectOption({ label: '修订模型 D · mock-reviser' });
    await page.getByLabel('结构化审稿').check();
    await page.getByRole('button', { name: '审阅已保存章节', exact: true }).click();
    await page.getByRole('heading', { name: '审稿报告 · 已完成' }).waitFor();

    // Only the selected, located issue is handed to the revision model.
    await page.getByLabel('采纳建议 issue-1').check();
    await page.getByRole('button', { name: '用修订模型生成候选（1 项）' }).click();
    await page.getByRole('heading', { name: '修订候选 · 已完成' }).waitFor();
    await page.getByText('已生成修订候选（1 个问题）', { exact: false }).waitFor();
    assert.equal(await page.getByLabel('AI 输出').textContent(), '林夏推开门。\n雨停了。');
    const reviseCall = calls.find(call => call.model === 'mock-reviser');
    assert.ok(reviseCall);
    assert.match(reviseCall.messages[0].content, /修订编辑/u);
    assert.match(reviseCall.messages[1].content, /只处理下列 1 个已定位问题/u);
    assert.match(reviseCall.messages[1].content, /把「推开们」改为「推开门」/u);
    assert.equal(calls.filter(call => call.model === 'mock-reviser').length, 1); // no automatic re-review loop
    await page.getByText('修订候选只针对所选问题生成', { exact: false }).first().waitFor();

    // The original chapter keeps its exact bytes; the candidate is a separate new DOCX.
    assert.deepEqual(await fs.readFile(path.join(folder, originalName)), original);
    await page.getByRole('button', { name: '候选另存 DOCX' }).click();
    await page.getByText('原正文保留', { exact: false }).waitFor();
    const created = (await fs.readdir(folder)).filter(name => name.endsWith('.docx') && name !== originalName);
    assert.equal(created.length, 1);
    const text = (await mammoth.extractRawText({ path: path.join(folder, created[0]) })).value;
    assert.match(text, /林夏推开门。/u); assert.doesNotMatch(text, /推开们/u);
    assert.deepEqual(await fs.readFile(path.join(folder, originalName)), original);
    assert.deepEqual(errors, []);
    console.log('Revision desktop passed: selected issues only, separate revision model, candidate DOCX, original bytes kept, single request, no auto re-review.');
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
