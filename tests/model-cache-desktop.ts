import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R14c-4: the model list is paginated in the UI and reused from cache until the author refreshes.
async function main() {
  let calls = 0;
  const models = Array.from({ length: 25 }, (_, index) => ({ id: `model-${String(index + 1).padStart(2, '0')}` }));
  const server = createServer((req, res) => {
    if (req.url?.includes('/models')) {
      calls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: models }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const fixture = path.resolve('.artifacts', `model-cache-desktop-${Date.now()}`), folder = path.join(fixture, '目录小说');
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
    await page.getByLabel('模型名称', { exact: true }).fill('model-01');
    // 060 起：有密钥的连接不读写共享缓存，这里用匿名连接验证缓存本身
    await page.getByLabel('API 密钥', { exact: true }).fill('');
    await page.getByRole('button', { name: '获取模型列表' }).click();
    await page.getByLabel('服务商模型列表').waitFor();
    assert.equal(calls, 1, '首次应请求服务');
    const firstPage = await page.getByLabel('服务商模型列表').locator('option').count();
    assert.equal(firstPage, 21, '第一页应为 20 个模型 + 占位项');
    await page.getByText(/第 1\/2 页/u).waitFor();
    await page.getByTestId('models-next').click();
    const secondPage = await page.getByLabel('服务商模型列表').locator('option').count();
    assert.equal(secondPage, 6, '第二页应为 5 个模型 + 占位项');
    await page.getByText(/第 2\/2 页/u).waitFor();
    // 再取一次：应命中缓存
    await page.getByRole('button', { name: '获取模型列表' }).click();
    await page.getByTestId('models-cached').waitFor();
    assert.equal(calls, 1, '命中缓存不应再次请求服务');
    await page.getByTestId('models-refresh').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="models-cached"]'), undefined, { timeout: 10000 });
    assert.equal(calls, 2, '刷新必须绕过缓存重新请求');
    console.log('Model cache desktop passed: 25 models paginated 20+5, cached on second fetch, refresh bypasses cache.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
