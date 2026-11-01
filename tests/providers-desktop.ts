import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  const fixture = path.resolve('.artifacts', `providers-desktop-${Date.now()}`), folder = path.join(fixture, '虚构接口测试小说'), local = path.join(fixture, 'app-data'); await fs.mkdir(folder, { recursive: true });
  const calls: { url: string; auth?: string; key?: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part; calls.push({ url: req.url!, auth: req.headers.authorization, key: req.headers['x-goog-api-key'] as string ?? req.headers['x-api-key'] as string, body: raw ? JSON.parse(raw) : null });
    if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url === '/g/models' ? { models: [{ name: 'models/gemini-test', supportedGenerationMethods: ['generateContent'] }] } : { data: [{ id: req.url === '/a/models' ? 'claude-test' : 'gateway-test@think=2' }] })); return; }
    res.setHeader('Content-Type', 'text/event-stream'); const event = (v: unknown) => res.write('data: ' + JSON.stringify(v) + '\n\n');
    if (req.url!.startsWith('/g/')) { event({ candidates: [{ index: 0, content: { parts: [{ text: '忽略的推理', thought: true }, { text: 'Gemini虚构候选正文。' }] } }] }); event({ candidates: [{ index: 0, finishReason: 'STOP' }] }); }
    else if (req.url === '/a/messages') { event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }); event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Claude虚构审稿报告。' } }); event({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }); event({ type: 'message_stop' }); }
    else { event({ choices: [{ index: 0, delta: { content: '本地网关虚构候选。' } }] }); event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }); res.write('data: [DONE]\n\n'); }
    res.end();
  }); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const require = createRequire(import.meta.url), app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: local } }), page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    const catalog = await page.getByLabel('快捷配置').locator('option').allTextContents(); assert.ok(catalog.includes('OpenAI Compatible')); assert.ok(catalog.includes('Google Gemini')); assert.ok(catalog.includes('Anthropic')); assert.ok(catalog.includes('Ollama')); // Responses 已在 R14c-7 适配，不再是待适配
    assert.ok(catalog.some(t => t.includes('Responses') && !t.includes('待适配')), 'Responses 现在应可选');
    for (const [preset, suffix, model, key] of [['Google Gemini', '/g', 'gemini-test', 'native-key'], ['Anthropic', '/a', 'claude-test', 'native-key'], ['Ollama', '/v1', 'gateway-test@think=2', ''], ['gemini-web2api · 本地兼容', '/v1', 'gateway-test@think=2', 'gateway-key']]) {
      await page.getByRole('button', { name: '＋ 新增模型连接', exact: true }).click(); await page.getByLabel('快捷配置').selectOption({ label: preset });
      if (preset === 'Ollama') assert.equal(await page.getByLabel('API 基础地址', { exact: true }).inputValue(), 'http://127.0.0.1:11434/v1');
      if (preset.startsWith('gemini-web2api')) assert.equal(await page.getByLabel('API 基础地址', { exact: true }).inputValue(), 'http://127.0.0.1:8081/v1');
      await page.getByLabel('API 基础地址', { exact: true }).fill(url + suffix); if (key) await page.getByLabel('API 密钥', { exact: true }).fill(key);
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click(); await page.getByLabel('服务商模型列表').selectOption(model);
      await page.getByRole('button', { name: '保存模型连接', exact: true }).click(); await page.getByText('模型连接已保存', { exact: true }).waitFor(); await page.getByRole('button', { name: '测试连接（少量 token）', exact: true }).click(); await page.getByRole('status').filter({ hasText: '连接可用' }).waitFor();
      assert.equal(await page.getByLabel('API 密钥', { exact: true }).inputValue(), '');
    }
    await page.getByRole('button', { name: '嵌入模型', exact: true }).click(); assert.equal(await page.getByLabel('嵌入模型提供商').locator('option:not([disabled])').count(), 5);
    await page.getByLabel('嵌入模型提供商').selectOption('ollama_embedding'); assert.equal(await page.getByLabel('嵌入模型 API 基础地址').inputValue(), 'http://localhost:11434'); await page.getByRole('button', { name: '保存嵌入模型配置', exact: true }).click(); await page.getByText('嵌入模型配置已保存', { exact: true }).waitFor();
    await page.getByLabel('嵌入模型连接名称').fill('本机向量模型'); await page.getByRole('button', { name: '保存嵌入模型配置', exact: true }).click(); await page.getByText('嵌入模型配置已保存', { exact: true }).waitFor();
    await page.getByRole('button', { name: '重排序模型', exact: true }).click(); assert.equal(await page.getByLabel('重排序模型提供商').locator('option:not([disabled])').count(), 5); await page.getByLabel('重排序模型提供商').selectOption('tei_rerank'); await page.getByRole('button', { name: '保存重排序模型配置', exact: true }).click(); await page.getByText('重排序模型配置已保存', { exact: true }).waitFor();
    assert.deepEqual((await page.evaluate(() => window.writer.auxiliaryModels())).connections.map(c => c.kind).sort(), ['embedding', 'rerank']);
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder); await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click(); await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).click(); await page.locator('.tiptap').fill('虚构接口测试正文。'); await page.getByRole('button', { name: '保存 DOCX', exact: true }).click(); await page.getByText('DOCX 已保存到所选文件夹', { exact: true }).waitFor();
    const original = (await page.evaluate(async () => { const p = (await window.writer.listProjects())[0]; const chapter = (await window.writer.chapters(p.id))[0]; return window.writer.readChapter(p.id, chapter.path); })); const bytes = await fs.readFile(path.join(folder, original.path));
    const saved = await page.evaluate(() => window.writer.aiConnections());
    for (const [name, mode] of [['Google Gemini', 'write'], ['Anthropic', 'review'], ['gemini-web2api', 'write']] as const) {
      const connection = saved.connections.find(c => c.name === name)!;
      const task = await page.evaluate(({ chapter, id, mode }) => window.writer.startAI({ projectId: chapter.projectId, chapterPath: chapter.path, sourceHash: chapter.hash, connectionId: id, mode, instruction: '虚构协议测试' }), { chapter: original, id: connection.id, mode });
      await page.waitForFunction(async ({ projectId, id }) => (await window.writer.aiTasks(projectId)).find(t => t.id === id)?.status === 'complete', { projectId: original.projectId, id: task.id });
      // 父任务完成时可能仍有自动审稿子任务在跑；必须等整批落定再发下一个请求，
      // 否则 ai:start 会正确地报"已有 AI 任务运行"。
      await page.waitForFunction(async projectId => {
        const tasks = await window.writer.aiTasks(projectId);
        return !tasks.some(item => item.status === 'running');
      }, original.projectId, { timeout: 30000 });
      await page.waitForTimeout(200);
      await page.waitForFunction(async projectId => {
        const tasks = await window.writer.aiTasks(projectId);
        return !tasks.some(item => item.status === 'running');
      }, original.projectId, { timeout: 30000 });
      const complete = (await page.evaluate(id => window.writer.aiTasks(id), original.projectId)).find(t => t.id === task.id)!; assert.ok(!complete.text.includes('忽略的推理')); assert.equal(complete.connection.adapter, connection.adapter);
    }
    assert.deepEqual(await fs.readFile(path.join(folder, original.path)), bytes);
    assert.ok(calls.some(c => c.url === '/a/messages' && c.key === 'native-key' && !c.auth)); assert.ok(calls.some(c => c.url.startsWith('/g/models/') && c.key === 'native-key')); assert.ok(calls.some(c => c.url === '/v1/chat/completions' && !c.auth)); assert.ok(calls.some(c => c.url === '/v1/chat/completions' && c.auth === 'Bearer gateway-key'));
    await page.getByRole('button', { name: '模型设置', exact: true }).click(); await page.getByRole('button', { name: '对话模型', exact: true }).click(); await page.getByRole('button', { name: '＋ 新增模型连接', exact: true }).click(); await page.getByLabel('快捷配置').selectOption({ label: 'Google Gemini' });
    await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())))); const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')); await fs.writeFile(path.resolve('.artifacts/provider-settings.png'), Buffer.from(png, 'base64'));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 760)); const box = await page.getByRole('button', { name: '保存并退出', exact: true }).boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= 1000);
    assert.deepEqual(errors, []); console.log('Provider desktop passed: AstrBot catalog, native generation/review/history and secrets, local Ollama/gemini-web2api routes, separate 5+5 auxiliary settings, edits, raw DOCX protection and 1000px navigation.');
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
