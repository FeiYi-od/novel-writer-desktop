import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  const fixture = path.resolve('.artifacts', `embedding-desktop-${Date.now()}`), data = path.join(fixture, 'app-data'); await fs.mkdir(fixture, { recursive: true }); let slow = false, calls = 0;
  const server = createServer(async (req, res) => { calls++; let raw = ''; for await (const part of req) raw += part; const body = JSON.parse(raw); assert.deepEqual(body.input, ['虚构的学园位于山谷。', '虚构人物在图书馆阅读。']); assert.equal(body.truncate, false); if (slow) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); return; } res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ embeddings: [[1, 2, 3], [4, 5, 6]] })); }); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const require = createRequire(import.meta.url), app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: data } }), page = await app.firstWindow(); page.setDefaultTimeout(15000);
  try {
    await page.getByRole('button', { name: '模型设置', exact: true }).click(); await page.getByRole('button', { name: '嵌入模型', exact: true }).click(); await page.getByLabel('嵌入模型提供商').selectOption('ollama_embedding'); await page.getByLabel('嵌入模型 API 基础地址').fill(`http://127.0.0.1:${(server.address() as any).port}`); await page.getByLabel('嵌入模型 嵌入维度').fill('4'); await page.getByRole('button', { name: '保存嵌入模型配置', exact: true }).click(); await page.getByText('嵌入模型配置已保存', { exact: true }).waitFor(); const file = path.join(data, 'auxiliary-models.json'), before = await fs.readFile(file); assert.equal(calls, 0);
    await page.getByRole('button', { name: '测试嵌入模型（虚构文本）', exact: true }).click(); await page.getByRole('status').filter({ hasText: '实际3维；配置维度不匹配' }).waitFor(); assert.deepEqual(await fs.readFile(file), before); assert.equal(await page.getByLabel('嵌入模型 嵌入维度').inputValue(), '4');
    await page.getByLabel('嵌入模型 嵌入维度').fill('3'); assert.equal(await page.getByRole('button', { name: '测试嵌入模型（虚构文本）', exact: true }).isDisabled(), true); await page.getByRole('button', { name: '保存嵌入模型配置', exact: true }).click(); await page.getByText('嵌入模型配置已保存', { exact: true }).waitFor(); await page.getByRole('button', { name: '测试嵌入模型（虚构文本）', exact: true }).click(); await page.getByRole('status').filter({ hasText: '实际3维，维度匹配' }).waitFor();
    await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())))); const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')); await fs.writeFile(path.resolve('.artifacts/embedding-test.png'), Buffer.from(png, 'base64'));
    slow = true; await page.getByRole('button', { name: '测试嵌入模型（虚构文本）', exact: true }).click(); await page.getByRole('button', { name: '停止嵌入测试', exact: true }).waitFor(); await page.getByRole('button', { name: '保存并退出', exact: true }).click(); await page.getByRole('alert').filter({ hasText: '正在处理' }).first().waitFor(); assert.equal(app.process().exitCode, null); await page.getByRole('button', { name: '停止嵌入测试', exact: true }).click(); await page.getByRole('alert').filter({ hasText: '嵌入测试已停止' }).first().waitFor();
    await page.getByRole('button', { name: '重排序模型', exact: true }).click(); assert.equal(await page.getByRole('button', { name: '测试嵌入模型（虚构文本）', exact: true }).isVisible(), false);
    console.log('Embedding desktop passed: explicit fixed-text probe, actual dimensions/mismatch, no automatic configuration or index writes, unsaved disable, cancellation and exit guard.');
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
