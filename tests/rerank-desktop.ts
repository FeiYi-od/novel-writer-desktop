import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { createServer, type ServerResponse } from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  const fixture = path.resolve('.artifacts', `rerank-desktop-${Date.now()}`);
  const folder = path.join(fixture, '虚构重排测试小说'), data = path.join(fixture, 'app-data');
  await fs.mkdir(folder, { recursive: true });
  const documents = ['虚构的学园位于山谷。', '虚构人物在图书馆阅读。', '虚构列车驶向海边。'];
  const result = { results: [{ index: 0, relevance_score: 0.25 }, { index: 1, relevance_score: 0.9 }] };
  let hold = false, calls = 0;
  const pending: ServerResponse[] = [], requestErrors: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      calls++;
      let raw = ''; for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/rerank');
      assert.equal(req.headers.authorization, undefined);
      assert.equal(body.query, '虚构人物在哪里阅读？'); assert.deepEqual(body.documents, documents);
      assert.equal(body.top_n, 2); assert.equal(body.model, 'mock-reranker');
      res.setHeader('Content-Type', 'application/json');
      if (hold) { res.flushHeaders(); pending.push(res); return; }
      res.end(JSON.stringify(result));
    } catch (e) {
      requestErrors.push(String(e)); if (!res.headersSent) res.statusCode = 500; res.end('{}');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const waitForCalls = async (count: number) => {
    const deadline = Date.now() + 5000;
    while (calls < count && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.equal(calls, count, 'Only explicit test actions should make requests');
  };
  const release = () => { hold = false; for (const res of pending.splice(0)) if (!res.destroyed) res.end(JSON.stringify(result)); };
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: data } });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  try {
    // A saved fictional chapter proves diagnostic requests leave the source manuscript alone.
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).click();
    await page.locator('.tiptap').fill('仅属于此测试小说的正文，重排序诊断不得发送这句话。');
    await page.getByRole('button', { name: '保存 DOCX', exact: true }).click();
    await page.getByText('DOCX 已保存到所选文件夹', { exact: true }).waitFor();
    const chapter = await page.evaluate(async () => { const p = (await window.writer.listProjects())[0]; const entry = (await window.writer.chapters(p.id))[0]; return window.writer.readChapter(p.id, entry.path); });
    const original = await fs.readFile(path.join(folder, chapter.path));

    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByRole('button', { name: '重排序模型', exact: true }).click();
    const testButton = page.getByRole('button', { name: '测试重排序模型（虚构文本）', exact: true });
    const stopButton = page.getByRole('button', { name: '停止重排序测试', exact: true });
    assert.equal(await testButton.isDisabled(), true);
    await page.getByLabel('重排序模型提供商').selectOption('vllm_rerank');
    await page.getByLabel('重排序模型 API 基础地址').fill(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    await page.getByLabel('重排序模型 模型名称').fill('mock-reranker');
    assert.equal(await testButton.isDisabled(), true); assert.equal(calls, 0);
    await page.getByRole('button', { name: '保存重排序模型配置', exact: true }).click();
    await page.getByText('重排序模型配置已保存', { exact: true }).waitFor();
    const configFile = path.join(data, 'auxiliary-models.json'), savedBytes = await fs.readFile(configFile);
    assert.equal(calls, 0); assert.equal(await testButton.isEnabled(), true);

    await testButton.click();
    await page.getByRole('status').filter({ hasText: '重排序测试完成：3 条虚构候选，返回 2 条；顺序 2 → 1' }).waitFor();
    await waitForCalls(1);
    assert.deepEqual(await fs.readFile(configFile), savedBytes);
    assert.deepEqual(await fs.readFile(path.join(folder, chapter.path)), original);
    assert.equal(await page.getByLabel('重排序模型 模型名称').inputValue(), 'mock-reranker');
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
    await fs.writeFile(path.resolve('.artifacts/rerank-test.png'), Buffer.from(png, 'base64'));

    // Unsaved settings cannot silently reuse a different saved model; selecting it is also inert.
    await page.getByLabel('重排序模型连接名称').fill('未保存的重排序名称');
    assert.equal(await testButton.isDisabled(), true); assert.equal(calls, 1);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'vLLM Rerank', exact: true }).click();
    assert.equal(await testButton.isEnabled(), true); assert.equal(calls, 1);
    assert.deepEqual(await fs.readFile(configFile), savedBytes);

    // A running test remains busy while its page is hidden, and an unrelated cancel ID is rejected.
    hold = true; await testButton.click(); await stopButton.waitFor(); await waitForCalls(2);
    await assert.rejects(page.evaluate(() => window.writer.cancelRerankTest(crypto.randomUUID())), /会话已结束或不匹配/);
    await page.getByRole('button', { name: '嵌入模型', exact: true }).click();
    await page.getByRole('button', { name: '保存并退出', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '正在处理' }).first().waitFor();
    assert.equal(app.process().exitCode, null);
    await page.getByRole('button', { name: '重排序模型', exact: true }).click();
    await stopButton.click();
    await page.getByRole('alert').filter({ hasText: '重排序测试已停止' }).first().waitFor();
    assert.equal(await testButton.isEnabled(), true); release();
    assert.deepEqual(await fs.readFile(configFile), savedBytes);

    // An external configuration revision invalidates the in-flight result without overwriting it.
    hold = true; await testButton.click(); await stopButton.waitFor(); await waitForCalls(3);
    const external = JSON.parse(savedBytes.toString('utf8')); external.connections[0].name = '外部修改的重排序配置';
    const externalBytes = Buffer.from(JSON.stringify(external, null, 2)); await fs.writeFile(configFile, externalBytes);
    release();
    await page.getByRole('alert').filter({ hasText: '本次测试结果已丢弃' }).first().waitFor();
    assert.equal(await page.getByRole('status').filter({ hasText: '重排序测试完成' }).count(), 0);
    assert.deepEqual(await fs.readFile(configFile), externalBytes);
    assert.deepEqual(await fs.readFile(path.join(folder, chapter.path)), original);
    assert.deepEqual(requestErrors, []); assert.deepEqual(errors, []);
    assert.equal(calls, 3);
    console.log('Rerank desktop passed: explicit fixed-query/three-candidate probe, score order, saved/dirty gating, inert save/selection, unchanged config and DOCX, hidden-page exit guard, matching cancellation and discarded stale results.');
  } finally {
    await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {});
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
