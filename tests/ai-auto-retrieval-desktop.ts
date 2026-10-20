import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R28d-5: the writing request itself carries automatically retrieved canon basis.
async function main() {
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    bodies.push(JSON.parse(raw));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '林夏握紧月钥，雨声更近了。' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const fixture = path.resolve('.artifacts', `ai-auto-retrieval-desktop-${Date.now()}`), folder = path.join(fixture, '自动依据小说');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).click();
    await page.locator('.tiptap').fill('月钥只能开启北门。');
    await page.getByRole('button', { name: '保存 DOCX', exact: true }).click();
    await page.getByText('DOCX 已保存到所选文件夹', { exact: true }).waitFor();

    // Confirm the saved version so it becomes canon the automatic retrieval may cite.
    const confirmed = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const chapter = (await window.writer.chapters(id))[0];
      const preview = await window.writer.previewChapterConfirmation(id, chapter.path);
      const snapshot = await window.writer.chapterConfirmations(id);
      return window.writer.confirmChapterVersion({ projectId: id, path: chapter.path, sourceHash: preview.hash, expectedHash: snapshot.hash });
    });
    assert.ok(confirmed.value.entries.length >= 1);

    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByLabel('快捷配置').selectOption({ label: 'DeepSeek' });
    await page.getByLabel('深度思考').selectOption('disabled');
    await page.getByLabel('API 基础地址', { exact: true }).fill(`http://127.0.0.1:${port}/v1`);
    await page.getByLabel('连接名称', { exact: true }).fill('自动依据模型');
    await page.getByLabel('模型名称', { exact: true }).fill('mock-writer');
    await page.getByLabel('API 密钥', { exact: true }).fill('test-only-key');
    await page.getByRole('button', { name: '保存模型连接', exact: true }).click();
    await page.getByText('模型连接已保存', { exact: true }).waitFor();

    await page.getByRole('button', { name: '写作空间', exact: true }).click();
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    await page.getByRole('button', { name: '打开 AI 写作与审稿' }).click();
    await page.getByLabel('写作模型', { exact: true }).selectOption({ label: '自动依据模型 · mock-writer' });
    await page.getByLabel('自动附带检索依据').check();
    await page.getByLabel('写作要求').fill('续写雨夜场景 月钥 北门');
    await page.getByRole('button', { name: '生成正文候选', exact: true }).click();
    await page.getByRole('heading', { name: '正文候选 · 已完成' }).waitFor();

    // The card reports what actually ran; without embeddings it degrades to keyword but still cites canon.
    await page.getByText(/自动检索：请求 hybrid · 实际 keyword · 附带 1 段；.*(降级|尚未配置)/u).first().waitFor();
    assert.equal(bodies.length, 1);
    const prompt = bodies[0].messages.map(message => message.content).join('\n');
    assert.match(prompt, /月钥只能开启北门/u, '自动检索的依据必须进入实际请求');
    assert.deepEqual(errors, []);
    console.log('AI auto retrieval desktop passed: confirmed canon retrieved, mode degradation reported, basis injected into the real request.');
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
