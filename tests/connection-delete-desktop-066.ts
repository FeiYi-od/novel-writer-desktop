import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R3：模型连接删除（界面入口；不联网、不测试真实服务商）
async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/connection-delete-desktop-'));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(25000);
    page.on('dialog', dialog => void dialog.accept());
    // 用 API 建两个连接（本机夹具，不发网络请求）
    const created = await page.evaluate(async () => {
      const before = await window.writer.aiConnections();
      const first = await window.writer.saveAIConnection({ name: '夹具甲', adapter: 'generic', thinking: 'default', timeoutSeconds: 300, baseUrl: 'https://api.example.com/v1', model: 'model-a', contextWindow: 8192, maxOutputTokens: 1024, tokenParameter: 'max_tokens', apiKey: 'sk-test-a' }, before.hash);
      const second = await window.writer.saveAIConnection({ name: '夹具乙', adapter: 'generic', thinking: 'default', timeoutSeconds: 300, baseUrl: 'https://api.example.com/v1', model: 'model-b', contextWindow: 8192, maxOutputTokens: 1024, tokenParameter: 'max_tokens' }, first.hash);
      return second.connections.map(item => ({ id: item.id, name: item.name }));
    });
    assert.equal(created.length, 2);
    await page.getByRole('button', { name: '模型设置' }).click();
    await page.getByRole('button', { name: /夹具甲/ }).click();
    await page.getByTestId('connection-remove').click();
    await page.waitForFunction(async () => (await window.writer.aiConnections()).connections.length === 1, undefined, { timeout: 20000 });
    const after = await page.evaluate(async () => (await window.writer.aiConnections()).connections.map(item => item.name));
    assert.deepEqual(after, ['夹具乙']);
    await page.reload();
    await page.getByRole('button', { name: '模型设置' }).click();
    await page.getByRole('button', { name: new RegExp(after[0]!) }).click();
    await page.getByTestId('connection-remove').click();
    await page.waitForFunction(async () => (await window.writer.aiConnections()).connections.length === 0, undefined, { timeout: 15000 });
    console.log('Connection delete desktop passed: 界面删除连接后列表与磁盘一致，未联网。');
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
