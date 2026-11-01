import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Device-local Zhuque usage: unknown attempts persisted before HTTP, Makers deduction kept
// separately from model tokens, manual calibration, restart persistence and exit protection.
async function main() {
  const calls: { text: string }[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw) as { text: string; is_merge: unknown }; calls.push({ text: body.text });
    res.setHeader('Content-Type', 'application/json');
    if (body.text.includes('错误')) { res.writeHead(500); res.end(JSON.stringify({ makers_models_usage: { total_tokens: 12 } })); return; }
    const makers = body.text.includes('固定虚构短文') ? 5 : 30;
    res.end(JSON.stringify({ status: 'success', labels_ratio: { '0': 0.6, '1': 0.3, '2': 0.1 }, softmax_confidence: 0.82,
      usage: { total_tokens: 50 }, makers_models_usage: { total_tokens: makers }, segment_labels: [] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const fixture = path.resolve('.artifacts', `zhuque-usage-desktop-${Date.now()}`), folder = path.join(fixture, '用量测试小说');
  const local = path.join(fixture, 'app-data'); await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  let app: ElectronApplication | null = null; let page!: Page; const errors: string[] = []; let original = Buffer.alloc(0); let textName = '';
  const launch = async () => { app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: local } }); page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message)); };
  const open = async (title = '用量测试小说') => { await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, title === '用量测试小说' ? folder : path.join(fixture, title)); await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click(); await page.getByText(`已打开「${title}」`, { exact: false }).first().waitFor(); };
  const stat = async (index: number, value: string) => page.waitForFunction(({ index, value }) => (document.querySelectorAll('.usage-stat strong')[index]?.textContent ?? '').trim() === value, { index, value });
  const estimated = async (value: string) => page.waitForFunction(target => (document.querySelector('.usage-progress-heading strong')?.textContent ?? '').trim() === target, value);
  const capture = async (name: string) => {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const png = await app!.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
    await fs.writeFile(path.resolve('.artifacts', name), Buffer.from(png, 'base64'));
  };
  try {
    await launch(); await open();
    await page.getByLabel('新章节格式').selectOption('txt');
    await page.getByRole('button', { name: '＋ 新建 TXT 章节' }).click();
    await page.locator('.tiptap').fill('第一段虚构检测正文。');
    await page.getByRole('button', { name: '保存 TXT', exact: true }).click();
    await page.getByText('TXT 已保存到所选文件夹', { exact: true }).waitFor();
    textName = (await fs.readdir(folder)).find(name => name.endsWith('.txt'))!; original = await fs.readFile(path.join(folder, textName));

    // 密钥与连接改到“模型设置 → 朱雀检测连接”
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByRole('button', { name: '朱雀检测连接', exact: true }).click();
    await page.getByLabel('朱雀网关地址').fill(baseUrl); await page.getByLabel('朱雀 API Key').fill('desktop-zhuque-secret');
    await page.getByRole('button', { name: '保存朱雀连接' }).click(); await page.getByText('朱雀连接已保存（密钥经系统加密，仅本机可用）', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('朱雀 API Key').inputValue(), '');

    // Explicit connection test with fixed fictional text, still in settings; deduction counted, no chapter report.
    await page.getByRole('button', { name: '测试连接（消耗额度）' }).click();
    await page.getByText('朱雀连接测试完成，结果按本机用量记录', { exact: true }).waitFor();
    assert.match(await page.locator('.detection-test-result').innerText(), /本次扣减[\s\S]*5 Token/u);
    assert.match(calls.at(-1)!.text, /固定虚构短文/u); assert.ok(!calls.at(-1)!.text.includes('第一段虚构检测正文'));

    await page.getByText('更多功能', { exact: true }).click(); await page.getByRole('button', { name: '朱雀检测', exact: true }).click();
    await page.getByText('本机朱雀用量', { exact: true }).waitFor();
    await stat(0, '1'); await stat(2, '5'); await estimated('5');

    // Chapter detection keeps both usage numbers and shows them on the report.
    await page.getByRole('button', { name: '发送章节并检测 AI 率' }).click(); await page.getByText('朱雀检测完成', { exact: true }).waitFor();
    await page.locator('.detection-report-usage').waitFor();
    assert.match(await page.locator('.detection-report-usage').innerText(), /Makers 实际扣减：30 Token[\s\S]*模型自身用量：50 Token/u);
    await stat(0, '2'); await stat(2, '35'); await estimated('35');
    assert.deepEqual(await fs.readFile(path.join(folder, textName)), original);

    // Manual calibration: account total replaces the local baseline, later deductions add on top.
    await page.locator('.usage-quota-settings summary').click();
    await page.getByLabel('朱雀账户已用').fill('1000');
    await page.getByRole('button', { name: '保存额度与校准' }).click();
    await page.getByText('已按控制台数据校准账户已用，此后按本机扣减累加', { exact: true }).waitFor();
    await estimated('1,000');
    // An unsaved calibration blocks "保存并退出" instead of silently leaving the window.
    await page.getByLabel('朱雀账户已用').fill('1200');
    await page.getByRole('button', { name: '保存并退出', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '保存并退出未完成' }).first().waitFor();
    assert.match(await page.getByRole('alert').first().innerText(), /未保存内容|未确认/u);
    assert.equal(app!.process().exitCode, null);
    await page.getByLabel('朱雀账户已用').fill('1000');
    await page.getByRole('button', { name: '保存额度与校准' }).click();
    await estimated('1,000');

    // A failed request still records the deduction the service reported, and never claims zero.
    await page.getByRole('button', { name: '写作空间', exact: true }).click();
    await page.locator('.tiptap').fill('这段虚构正文会让模拟服务返回错误。');
    await page.getByRole('button', { name: '保存 TXT', exact: true }).click();
    await page.getByText('TXT 已保存到所选文件夹', { exact: true }).waitFor();
    await page.getByText('更多功能', { exact: true }).click(); await page.getByRole('button', { name: '朱雀检测', exact: true }).click();
    await page.getByRole('button', { name: '发送章节并检测 AI 率' }).click();
    await page.getByRole('alert').filter({ hasText: 'HTTP 500' }).first().waitFor();
    assert.match(await page.getByRole('alert').first().innerText(), /12 Token/u);
    await stat(1, '1'); await stat(2, '47'); await estimated('1,012');
    await page.evaluate(() => { window.scrollTo(0, 0); document.querySelectorAll('*').forEach(node => { if (node.scrollTop > 0) node.scrollTop = 0; }); });
    await capture('zhuque-usage.png');

    // The ledger holds no credential material and keeps one file per connection credential.
    const ledger = path.join(local, 'detection-usage');
    const files = (await fs.readdir(ledger, { recursive: true })).filter(name => String(name).endsWith('.json'));
    assert.ok(files.length >= 1);
    for (const name of files) assert.ok(!(await fs.readFile(path.join(ledger, String(name)), 'utf8')).includes('desktop-zhuque-secret'));
    assert.ok(!JSON.stringify(calls).includes('desktop-zhuque-secret'));

    // Restart keeps the counters and the calibration. Use the documented exit path: a forced
    // app.exit(0) right after saving a credential is a known open issue, not this batch's claim.
    const closing = app!.waitForEvent('close');
    await page.getByRole('button', { name: '保存并退出', exact: true }).click();
    await closing; app = null;
    await launch(); await open(); await page.getByText('更多功能', { exact: true }).click(); await page.getByRole('button', { name: '朱雀检测', exact: true }).click();
    await page.getByText('本机朱雀用量', { exact: true }).waitFor();
    await stat(0, '3'); await stat(1, '1'); await stat(2, '47'); await estimated('1,012');

    // Batch review: a chapter created after the page mounted is picked up when the panel opens.
    const projectId = (await page.evaluate(() => window.writer.listProjects()))[0].id;
    await page.evaluate(async id => {
      const chapter = await window.writer.createChapter(id, 'txt');
      await window.writer.saveChapter({ projectId: id, path: chapter.path, expectedHash: chapter.hash,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '　　第二章虚构正文。' }] }] } });
    }, projectId);
    await page.locator('.detection-batch summary').click();
    await page.locator('.detection-batch').getByRole('button', { name: '全选' }).click();
    await page.locator('.detection-batch').getByRole('button', { name: '批量检测所选章节' }).click();
    await page.getByText('批量检测完成：成功 1/2，失败 1', { exact: true }).waitFor();
    const progress = await page.locator('.detection-batch-progress').innerText();
    assert.match(progress, /进度 2\/2 · 成功 1 · 失败 1/u);
    assert.match(progress, /HTTP 500/u); assert.match(progress, /12 Token/u);
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="朱雀检测历史"] option').length === 2);
    // The failed chapter is counted in the ledger but produced no report, and nothing was retried.
    await stat(0, '5'); await stat(1, '2'); await stat(2, '89');
    assert.equal(calls.filter(call => call.text.includes('会让模拟服务返回错误')).length, 2); // once alone, once in the batch
    await page.locator('.detection-batch').scrollIntoViewIfNeeded();
    await capture('zhuque-batch.png');

    // Usage is device/connection scoped, while reports stay per novel.
    const other = path.join(fixture, '另一本小说'); await fs.mkdir(other); await open('另一本小说');
    await page.getByText('更多功能', { exact: true }).click(); await page.getByRole('button', { name: '朱雀检测', exact: true }).click();
    await page.getByText('尚无检测报告。填写自己的 Makers API Key 后可发起检测。', { exact: true }).waitFor();
    await stat(0, '5');
    assert.deepEqual(errors, []);
    console.log('Zhuque usage desktop passed: fixed-text connection test, persisted unknown attempts, separated Makers/model tokens, calibration and limit-only save, failed-request deduction, batch review with per-chapter failure, exit protection, restart, per-book reports, no key in ledger.');
  } finally { const remaining = app as ElectronApplication | null; if (remaining) await remaining.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
