import { listenLocalHttp } from './support/local-http';
import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  let fail = true, calls = 0, longMode = false, failDeepOnce = false, statusCode = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); const system = String(body.messages[0].content), user = String(body.messages[1].content); calls++;
    if (fail && system.includes('这一段参考文本') && user.includes('第 2/')) { res.writeHead(500); res.end('fixture failure'); return; }
    const isChunk = system.includes('这一段参考文本'), isLayer = system.includes('压缩成不超过 1200 字');
    if (statusCode && isChunk && user.includes('第 2/')) { res.writeHead(statusCode); res.end('fixture quota'); return; }
    if (longMode && failDeepOnce && isLayer && user.includes('【分层汇总')) { failDeepOnce = false; res.writeHead(500); res.end('fixture deep failure'); return; }
    const text = isLayer ? '略。'.repeat(400) : isChunk ? (longMode ? '细节说明。'.repeat(400) : '短句与对话结合，动作自然。') : JSON.stringify({ rules: ['短句推进', '对白接动作', '控制段落长度'], limitations: [] });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await listenLocalHttp(server);
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/style-model-safety-desktop-'));
  const folder = path.join(fixture, '虚构作品'); await fs.mkdir(folder);
  const reference = path.join(fixture, '虚构参考.txt'); await fs.writeFile(reference, '虚构对白：“早安。”他抬头看向天空，阳光洒在书桌边。\n'.repeat(1200));
  const args = process.argv.slice(2); assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--exe' && path.isAbsolute(args[1]!)));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: args.length ? args[1]! : createRequire(import.meta.url)('electron'), args: args.length ? [] : [path.resolve('out/main/index.js')], env });
  const page = await app.firstWindow(); page.setDefaultTimeout(30000); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const choose = (selected: string) => app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, selected);
  try {
    if (args.length) { const info = await app.evaluate(({app}) => ({ packaged: app.isPackaged, version: app.getVersion() })); assert.equal(info.packaged, true); assert.equal(info.version, JSON.parse(await fs.readFile('package.json', 'utf8')).version); }
    await choose(folder); await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click(); await page.getByText('已打开「虚构作品」', { exact: false }).waitFor();
    const projectId = (await page.evaluate(() => window.writer.listProjects()))[0]!.id;
    await page.evaluate(async baseUrl => { const before = await window.writer.aiConnections(); await window.writer.saveAIConnection({ name: '本机模拟模型', model: 'fixture', baseUrl, adapter: 'generic', thinking: 'default', timeoutSeconds: 60, contextWindow: 14000, maxOutputTokens: 1024, tokenParameter: 'max_tokens' }, before.hash); }, `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
    await page.reload(); await page.getByRole('button', { name: '打开作品 虚构作品' }).click();
    await page.getByRole('button', { name: '文风研习室', exact: true }).click(); await choose(reference); await page.getByRole('button', { name: '＋ 导入文本', exact: true }).click();
    await page.locator('.source-list').getByRole('checkbox').check(); await page.getByLabel('文风名称', { exact: true }).fill('安全文风');
    await page.getByLabel('文风分析模型').selectOption({ label: '本机模拟模型 · fixture' }); await page.getByLabel('模型分析范围').selectOption('full');
    await page.getByTestId('style-plan').click();
    const result = page.getByTestId('style-plan-result'); await result.waitFor();
    const previewText = await result.innerText(); const previewChunks = Number(previewText.match(/：(\d+) 段/u)?.[1]);
    assert.ok(previewChunks > 1); assert.equal(calls, 0, '预估不得调用模型');
    await page.getByRole('button', { name: '用模型分析选中语料', exact: true }).click();
    await page.getByText('部分分段未完成，不能保存为完整文风；已完成的笔记会保留。').waitFor();
    await page.getByTestId('style-resume').waitFor();
    const tasks = await page.evaluate(id => window.writer.aiTasks(id), projectId);
    assert.equal(tasks.find(task => task.mode === 'style-analysis')?.styleSource?.chunks, previewChunks, '预估段数需等于实际任务');
    assert.equal(await page.getByRole('button', { name: '放入文风确认稿' }).isDisabled(), true);
    assert.equal((await page.evaluate(id => window.writer.readBook(id), projectId)).value.styles.length, 0);
    const before = calls; fail = false; await page.getByTestId('style-resume').click();
    await page.waitForFunction(() => { const button = [...document.querySelectorAll('button')].find(el => el.textContent === '放入文风确认稿'); return button && !button.disabled; }, undefined, { timeout: 30000 });
    assert.equal(calls - before, 2, '只恢复失败段并汇总');
    await page.getByRole('button', { name: '放入文风确认稿' }).click();
    assert.equal((await page.evaluate(id => window.writer.readBook(id), projectId)).value.styles.length, 0, '确认前不保存');
    await page.getByRole('button', { name: '确认保存模型文风' }).click(); await page.getByText('已确认保存模型文风，点击用于本书后生效').waitFor();
    assert.equal((await page.evaluate(id => window.writer.readBook(id), projectId)).value.styles.length, 1);
    longMode = true; failDeepOnce = true;
    await page.getByLabel('文风名称', { exact: true }).fill('多层文风');
    await page.getByRole('button', { name: '用模型分析选中语料', exact: true }).click();
    await page.getByTestId('style-resume').waitFor();
    const beforeResume = await page.evaluate(id => window.writer.aiTasks(id), projectId);
    const deepFailed = beforeResume.find(task => task.styleSource?.name === '多层文风');
    assert.equal(deepFailed?.status, 'failed'); assert.ok((deepFailed.styleSource?.mergeLevels?.[0]?.length ?? 0) > 1);
    await page.getByTestId('style-resume').click();
    await page.waitForFunction(() => { const button = [...document.querySelectorAll('button')].find(el => el.textContent === '放入文风确认稿'); return button && !button.disabled; }, undefined, { timeout: 30000 });
    const afterResume = await page.evaluate(id => window.writer.aiTasks(id), projectId);
    const deepDone = afterResume.find(task => task.styleSource?.name === '多层文风');
    assert.equal(deepDone?.status, 'complete'); assert.ok((deepDone.styleSource?.mergeLevels?.length ?? 0) > 1);
    assert.deepEqual(deepDone.styleSource?.mergeLevels?.[0], deepFailed.styleSource?.mergeLevels?.[0]);
    assert.equal((await page.evaluate(id => window.writer.readBook(id), projectId)).value.styles.length, 1, '多层结果仍需作者确认');
    longMode = false; statusCode = 402; const beforeQuota = calls;
    await page.getByLabel('文风名称', { exact: true }).fill('额度提示');
    await page.getByRole('button', { name: '用模型分析选中语料', exact: true }).click();
    await page.getByText(/模型账户余额或付款状态异常/).waitFor(); await page.getByTestId('style-resume').waitFor();
    assert.equal(calls - beforeQuota, 2, '限流后不能继续请求');
    statusCode = 0; await page.getByTestId('style-resume').click();
    await page.waitForFunction(() => { const button = [...document.querySelectorAll('button')].find(el => el.textContent === '放入文风确认稿'); return button && !button.disabled; }, undefined, { timeout: 30000 });
    assert.deepEqual(errors, []); console.log('Style model safety desktop passed: partial failure, no false completion, resume only missing segment, explicit confirmation.');
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
