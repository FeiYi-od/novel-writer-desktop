import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
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
    for await (const _part of request) { /* consume */ }
    calls++; response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (stall && calls === 2) { response.flushHeaders(); entered(); return; }
    const content = JSON.stringify({ characters: [{ name: '虚构人物', personality: '谨慎' }], world: [] });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/setting-checkpoint-'));
  const folder = path.join(fixture, '虚构断点书'); await fs.mkdir(folder);
  const file = path.join(folder, '正文.txt'), source = '仅供测试的长篇虚构正文。'.repeat(1800); await fs.writeFile(file, source);
  const args = process.argv.slice(2); assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--exe' && path.isAbsolute(args[1]!)));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null; let page!: Page; const dialogs: string[] = []; let accept = true;
  async function launch() {
    app = await electron.launch({ executablePath: args.length ? args[1]! : createRequire(import.meta.url)('electron'), args: args.length ? [] : [path.resolve('out/main/index.js')], env });
    if (args.length) { const info = await app.evaluate(({app}) => ({ packaged: app.isPackaged, version: app.getVersion() })); assert.equal(info.packaged, true); assert.equal(info.version, JSON.parse(await fs.readFile('package.json', 'utf8')).version); }
    page = await app.firstWindow(); page.setDefaultTimeout(30000); await page.setViewportSize({ width: 1000, height: 720 });
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
    await app.evaluate(({dialog}, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click(); await page.getByText('已打开「虚构断点书」', { exact: false }).waitFor();
  }
  try {
    await launch(); const id = (await page.evaluate(() => window.writer.listProjects()))[0]!.id;
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByLabel('连接名称', { exact: true }).fill('本机断点测试');
    await page.getByLabel('API 基础地址', { exact: true }).fill(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
    await page.getByLabel('模型名称', { exact: true }).fill('mock-checkpoint');
    await page.getByRole('button', { name: '保存模型连接', exact: true }).click(); await page.getByText('模型连接已保存', { exact: true }).waitFor();
    await page.getByRole('button', { name: '角色库', exact: true }).click(); await page.getByTestId('setting-extract-open').click();
    assert.equal(await page.getByLabel('保存全文整理本机断点').isChecked(), false);
    await page.getByLabel('保存全文整理本机断点').check(); await page.getByTestId('setting-book-prepare').click();
    const preview = page.getByTestId('setting-book-preview'); await preview.getByText(/当前窗口已完成 0 段/u).waitFor();
    const total = Number((await preview.innerText()).match(/共 (\d+) 段/u)?.[1]); assert.ok(total > 1);
    await page.getByTestId('setting-book-model').click(); await secondStarted;
    await page.getByTestId('setting-book-progress').getByText(/已完成 1 \/ \d+ 段/u).waitFor();
    await app!.evaluate(({app}) => app.exit(0)); app = null; stall = false;
    await launch(); await page.getByRole('button', { name: '角色库', exact: true }).click(); await page.getByTestId('setting-extract-open').click();
    const checkpoint = page.getByTestId('setting-checkpoint'); await checkpoint.getByText(/已完成 1 \/ \d+ 段/u).waitFor();
    assert.equal(calls, 2, '重启和查看断点不得自动调用模型');
    await checkpoint.getByRole('button', { name: '恢复本机断点' }).click();
    await page.getByTestId('setting-book-preview').getByText(/当前窗口已完成 1 段/u).waitFor();
    assert.equal(calls, 2, '恢复预览不得自动调用模型');
    await page.getByTestId('setting-book-model').click(); await page.getByLabel('选择 虚构人物').waitFor();
    assert.equal(calls, total + 1, '只补发中断段和未完成段');
    assert.ok(dialogs.some(message => message.includes(`预计请求剩余 ${total - 1} 次`)));
    assert.deepEqual((await page.evaluate(projectId => window.writer.readCharacters(projectId), id)).value.cards, []);
    assert.equal(await fs.readFile(file, 'utf8'), source);
    await page.getByTestId('setting-checkpoint').getByText(new RegExp(`已完成 ${total} / ${total} 段`, 'u')).waitFor();
    await page.getByTestId('setting-checkpoint').getByRole('button', { name: '删除本机断点' }).click();
    await page.getByText('本机整理断点已删除。', { exact: true }).waitFor();
    assert.equal(await page.evaluate(projectId => window.writer.readBookSettingsCheckpoint(projectId), id), null);
    await page.getByTestId('setting-extract').getByRole('button', { name: '关闭', exact: true }).click();
    const checkpointFile = path.join(fixture, 'profile', 'setting-checkpoints', `${id}.json`), unknown = Buffer.from('{"schemaVersion":99,"未识别":"虚构断点"}');
    await fs.writeFile(checkpointFile, unknown); await page.getByTestId('setting-extract-open').click();
    const warning = page.getByTestId('setting-extract').getByRole('alert').filter({ hasText: '本机断点读取失败' }); await warning.waitFor();
    const beforeReset = calls; accept = false; await warning.getByRole('button', { name: '备份并重置本机断点…' }).click();
    await page.waitForTimeout(100); assert.deepEqual(await fs.readFile(checkpointFile), unknown);
    accept = true; await warning.getByRole('button', { name: '备份并重置本机断点…' }).click();
    await page.getByText('断点已原样备份并移出当前使用位置：', { exact: false }).waitFor();
    const backups = await fs.readdir(path.join(fixture, 'profile', 'setting-checkpoints', 'quarantine'));
    assert.equal(backups.length, 1); assert.deepEqual(await fs.readFile(path.join(fixture, 'profile', 'setting-checkpoints', 'quarantine', backups[0]!)), unknown);
    await assert.rejects(fs.lstat(checkpointFile), /ENOENT/u); assert.equal(calls, beforeReset);
    console.log('Setting checkpoint desktop passed: abrupt process exit, explicit restore, remaining calls, unconfirmed protection, and preserved unknown checkpoint reset.');
  } finally { const active = app as ElectronApplication | null; if (active) await active.evaluate(({app}) => app.exit(0)).catch(() => {}); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
