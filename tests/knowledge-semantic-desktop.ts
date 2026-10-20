import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// 28d end-to-end: local Ollama-style embedding -> index rebuild -> semantic/hybrid search.
async function main() {
  const calls: string[][] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw) as { input?: string[]; model?: string };
    const inputs = body.input ?? [];
    calls.push(inputs);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ embeddings: inputs.map(text => [text.includes('月') ? 1 : 0, text.includes('雨') ? 1 : 0, 1]) }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const fixture = path.resolve('.artifacts', `knowledge-semantic-desktop-${Date.now()}`), folder = path.join(fixture, '语义检索小说');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).click();
    await page.locator('.tiptap').fill('林夏推开月门，月钥在谷仓。');
    await page.getByRole('button', { name: '保存 DOCX', exact: true }).click();
    await page.getByText('DOCX 已保存到所选文件夹', { exact: true }).waitFor();
    const original = await fs.readFile(path.join(folder, (await fs.readdir(folder)).find(name => name.endsWith('.docx'))!));
    const projectId = (await page.evaluate(() => window.writer.listProjects()))[0].id;

    const saved = await page.evaluate(async base => {
      const snapshot = await window.writer.auxiliaryModels();
      return window.writer.saveAuxiliaryModel({ kind: 'embedding', name: '本机 Ollama 验证', type: 'ollama_embedding',
        parameters: { embedding_api_base: base, embedding_model: 'bge-m3', timeout: 30, embedding_dimensions: 3 }, apiKey: '' }, snapshot.hash);
    }, endpoint);
    assert.ok(saved.connections.some(connection => connection.kind === 'embedding'));

    await page.getByRole('button', { name: '知识检索', exact: true }).click();
    await page.getByLabel('检索方式', { exact: true }).selectOption('semantic');
    await page.locator('.knowledge-index summary').click();
    await page.getByRole('button', { name: '刷新嵌入连接', exact: true }).click();
    await page.waitForFunction(() => !!(document.querySelector('[aria-label="嵌入连接"]') as HTMLSelectElement | null)?.value, undefined, { timeout: 15000 });
    await page.getByRole('button', { name: '重建索引', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '索引已更新' }).waitFor();
    await page.getByRole('button', { name: '读取索引状态', exact: true }).click();
    await page.getByText(/已建索引：\d+ 个分片 · 3 维/).waitFor();
    assert.ok(calls.length >= 1, '索引重建必须调用本机嵌入服务');
    assert.ok(calls[0].some(text => text.includes('月钥')));
    assert.deepEqual(await fs.readFile(path.join(folder, (await fs.readdir(folder)).find(name => name.endsWith('.docx'))!)), original, '索引不应修改正文');

    const semantic = await page.evaluate(async id => window.writer.searchKnowledge({ projectId: id, requestId: crypto.randomUUID(), corpus: 'discussion', query: '月钥', topK: 5, mode: 'semantic' }), projectId);
    assert.equal(semantic.usedMode, 'semantic');
    assert.ok(semantic.hits.some(hit => hit.text.includes('月钥')), '语义检索应命中已索引的正文');
    const hybrid = await page.evaluate(async id => window.writer.searchKnowledge({ projectId: id, requestId: crypto.randomUUID(), corpus: 'discussion', query: '月钥', topK: 5, mode: 'hybrid' }), projectId);
    assert.equal(hybrid.usedMode, 'hybrid');
    assert.ok(hybrid.hits.length >= 1);

    // Editing the chapter changes its hash, so a rebuild must embed the new chunk again.
    await page.getByRole('button', { name: '写作空间', exact: true }).click();
    await page.locator('.tiptap').fill('林夏推开月门，月钥在谷仓，雨声渐起。');
    await page.getByRole('button', { name: '保存 DOCX', exact: true }).click();
    await page.getByText('DOCX 已保存到所选文件夹', { exact: true }).waitFor();
    await page.getByRole('button', { name: '知识检索', exact: true }).click();
    await page.locator('.knowledge-index').evaluate((element: HTMLDetailsElement) => { element.open = true; });
    await page.getByRole('button', { name: '重建索引', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '索引已更新' }).waitFor();
    assert.match(await page.getByRole('status').filter({ hasText: '索引已更新' }).last().innerText(), /新嵌 [1-9]/);
    assert.deepEqual(errors, []);
    console.log('Knowledge semantic desktop passed: mock Ollama embed, rebuild, semantic and hybrid hits, re-embed after edit, novel text untouched.');
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
