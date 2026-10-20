import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R14c-3: model list shows inferred capabilities and can be filtered by them.
async function main() {
  const server = createServer((req, res) => {
    if (req.url?.includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }, { id: 'deepseek-reasoner' }, { id: 'text-embedding-3-large' }, { id: 'gemini-2.5-pro' }] }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const fixture = path.resolve('.artifacts', `capability-desktop-${Date.now()}`), folder = path.join(fixture, '能力小说');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByLabel('快捷配置').selectOption({ label: 'DeepSeek' });
    await page.getByLabel('深度思考').selectOption('disabled');
    await page.getByLabel('API 基础地址', { exact: true }).fill(`http://127.0.0.1:${port}/v1`);
    await page.getByLabel('模型名称', { exact: true }).fill('gpt-4o-mini');
    await page.getByLabel('API 密钥', { exact: true }).fill('test-only-key');
    await page.getByRole('button', { name: '获取模型列表' }).click();
    await page.getByLabel('服务商模型列表').waitFor();
    const options = await page.getByLabel('服务商模型列表').locator('option').allTextContents();
    assert.ok(options.some(text => text.includes('gpt-4o-mini') && text.includes('视觉')), `应给视觉模型加标签：${options.join(' | ')}`);
    assert.ok(options.some(text => text.includes('deepseek-reasoner') && text.includes('推理')), '应给推理模型加标签');
    assert.equal(options.length, 5, '四个模型 + 占位项');
    await page.getByLabel('能力筛选 推理').check();
    const filtered = await page.getByLabel('服务商模型列表').locator('option').allTextContents();
    assert.deepEqual(filtered.filter(text => text.trim() && !text.includes('选择一个模型')), ['deepseek-reasoner — 推理 · 工具'], `筛选后只剩推理模型：${filtered.join(' | ')}`);
    await page.getByLabel('能力筛选 视觉').check();
    const both = await page.getByLabel('服务商模型列表').locator('option').allTextContents();
    assert.equal(both.length, 1, '推理 + 视觉没有同时满足的模型时只剩占位项');
    console.log('Capability filter desktop passed: labels inferred and filtering narrows the list.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
