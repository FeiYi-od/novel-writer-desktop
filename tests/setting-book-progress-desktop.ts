import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  let calls = 0, stall = true;
  let entered!: () => void; const secondStarted = new Promise<void>(resolve => { entered = resolve; });
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume */ }
    calls++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (stall && calls === 2) { response.flushHeaders(); entered(); return; }
    const content = JSON.stringify({ characters: [{ name: '虚构人物', personality: '谨慎' }], world: [] });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/setting-progress-'));
  const folder = path.join(fixture, '虚构长篇'); await fs.mkdir(folder);
  const file = path.join(folder, '正文.txt'); const source = '虚构人物走过山谷。'.repeat(2400); await fs.writeFile(file, source);
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--exe' && path.isAbsolute(args[1]!)));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: args.length ? args[1]! : createRequire(import.meta.url)('electron'), args: args.length ? [] : [path.resolve('out/main/index.js')], env });
  try {
    if (args.length) { const info = await app.evaluate(({app}) => ({ packaged: app.isPackaged, version: app.getVersion() })); assert.equal(info.packaged, true); assert.equal(info.version, JSON.parse(await fs.readFile('package.json', 'utf8')).version); }
    const page = await app.firstWindow(); page.setDefaultTimeout(30000); await page.setViewportSize({ width: 1000, height: 720 }); const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.accept(); });
    await app.evaluate(({dialog}, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByText('已打开「虚构长篇」', { exact: false }).waitFor();
    const id = (await page.evaluate(() => window.writer.listProjects()))[0]!.id;
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByLabel('连接名称', { exact: true }).fill('本机进度测试');
    await page.getByLabel('API 基础地址', { exact: true }).fill(`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`);
    await page.getByLabel('模型名称', { exact: true }).fill('mock-progress');
    await page.getByRole('button', { name: '保存模型连接', exact: true }).click();
    await page.getByText('模型连接已保存', { exact: true }).waitFor();
    await page.getByRole('button', { name: '角色库', exact: true }).click();
    await page.getByTestId('setting-extract-open').click();
    await page.getByTestId('setting-book-prepare').click();
    const preview = page.getByTestId('setting-book-preview');
    await preview.getByText(/当前窗口已完成 0 段/u).waitFor();
    const total = Number((await preview.innerText()).match(/共 (\d+) 段/u)?.[1]); assert.ok(total > 1);
    await page.getByTestId('setting-book-model').click(); await secondStarted;
    const progress = page.getByTestId('setting-book-progress');
    await progress.getByText(/已完成 1 \/ \d+ 段/u).waitFor();
    await progress.screenshot({ path: path.join(fixture, 'progress.png') });
    await progress.getByRole('button', { name: '取消整理', exact: true }).click();
    await page.getByText(/已取消本次整理/u).waitFor();
    await preview.getByText(/当前窗口已完成 1 段/u).waitFor();
    assert.equal(await page.getByLabel('选择 虚构人物').count(), 0);
    assert.deepEqual((await page.evaluate(projectId => window.writer.readCharacters(projectId), id)).value.cards, []);
    assert.deepEqual(await page.evaluate(projectId => window.writer.listWorldBooks(projectId), id), []);
    assert.equal(await fs.readFile(file, 'utf8'), source);
    stall = false;
    await page.getByTestId('setting-book-model').click();
    await page.getByLabel('选择 虚构人物').waitFor();
    assert.equal(calls, total + 1, '已完成首段不重发，取消中的第二段需要重发');
    assert.ok(dialogs.some(message => message.includes(`预计请求剩余 ${total - 1} 次`)), '继续前应说明剩余请求次数');
    assert.deepEqual((await page.evaluate(projectId => window.writer.readCharacters(projectId), id)).value.cards, []);
    console.log('Book progress desktop passed: progress, cancellation, explicit in-window resume, no partial adoption and unchanged source.');
  } finally { await app.evaluate(({app}) => app.exit(0)).catch(() => {}); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
