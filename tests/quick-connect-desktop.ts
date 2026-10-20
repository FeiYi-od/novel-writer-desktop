import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// The "接入 API" entry: paste a key, save, and verify against the provider's model list.
async function main() {
  let authorized = false;
  const server = createServer((req, res) => {
    if (req.url?.includes('/models')) {
      if (!authorized) { res.writeHead(401).end('{"error":"bad key"}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model-a' }, { id: 'mock-model-b' }] }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const fixture = path.resolve('.artifacts', `quick-connect-${Date.now()}`), folder = path.join(fixture, '接入小说');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    await page.getByTestId('connect-open').click();
    const dialog = page.getByRole('dialog', { name: '接入 API' });
    await dialog.waitFor();
    await dialog.getByLabel('快速接入名称').fill('我的接入');
    await dialog.getByLabel('快速接入地址').fill(`http://127.0.0.1:${port}/v1`);
    await dialog.getByLabel('快速接入模型').fill('mock-model-a');
    await dialog.getByLabel('快速接入密钥').fill('sk-test-quick-connect');
    // 先测失败路径：服务返回 401
    await dialog.getByTestId('quick-save-test').click();
    await dialog.getByRole('alert').waitFor();
    assert.match(await dialog.getByRole('alert').innerText(), /权限不足|密钥/u, '无效密钥应给出可读原因');
    // 再测成功路径
    authorized = true;
    await dialog.getByLabel('快速接入密钥').fill('sk-test-quick-connect');
    await dialog.getByTestId('quick-save-test').click();
    await dialog.getByTestId('quick-result').waitFor();
    assert.match(await dialog.getByTestId('quick-result').innerText(), /连接成功：服务返回 2 个模型/u);
    const saved = await page.evaluate(async () => (await window.writer.aiConnections()).connections.map(item => ({ name: item.name, hasKey: item.hasKey, keyState: item.keyState })));
    assert.deepEqual(saved, [{ name: '我的接入', hasKey: true, keyState: 'ok' }]);
    const files = await fs.readdir(path.join(fixture, 'app-data'), { recursive: true, withFileTypes: true });
    for (const file of files.filter(entry => entry.isFile() && entry.name.startsWith('ai-connections'))) {
      const text = await fs.readFile(path.join((file as unknown as { parentPath: string }).parentPath, file.name), 'utf8');
      assert.ok(!text.includes('sk-test-quick-connect'), '连接文件里不能出现明文密钥');
    }
    console.log('Quick connect desktop passed: bad key explained, good key saved and verified, no plaintext on disk.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
