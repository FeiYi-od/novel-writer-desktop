import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R27b-1: 接近上下文上限时自动压缩旧消息，原文仍可展开。
async function main() {
  let calls = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    calls += 1;
    const body = JSON.parse(raw) as { messages: { role: string; content: string }[] };
    const system = body.messages.find(message => message.role === 'system')?.content ?? '';
    const summarizing = system.includes('对话压缩器');
    const text = summarizing ? '要点：作者确认先写雨夜入城，正史不含神族设定。' : '好的，按这个方向写。';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const fixture = path.resolve('.artifacts', `discussion-desktop-${Date.now()}`), folder = path.join(fixture, '讨论小说');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(30000);
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    // 连接配置：把上下文窗口压到最小合法值，让"接近上限"可在测试里复现
    await page.evaluate(async url => {
      const snapshot = await window.writer.aiConnections();
      await window.writer.saveAIConnection({
        name: '讨论模型', baseUrl: url, model: 'mock-chat', adapter: 'generic', thinking: 'default',
        timeoutSeconds: 120, contextWindow: 8192, maxOutputTokens: 512, tokenParameter: 'max_tokens', apiKey: 'sk-test-discussion'
      }, snapshot.hash);
    }, `http://127.0.0.1:${port}/v1`);
    await page.getByTestId('discussion-open').click();
    const dialog = page.getByRole('dialog', { name: '与模型讨论' });
    await dialog.waitFor();
    await dialog.getByLabel('讨论模型').selectOption({ label: '讨论模型 · mock-chat' });
    // UTF-8保守预算下留出模型输出空间，每条问题本身可完整放入请求。
    const long = '我们要确定这件事：'.repeat(60);
    for (let index = 0; index < 7; index++) {
      await dialog.getByLabel('讨论输入').fill(`${long}（第 ${index + 1} 段）`);
      await dialog.getByTestId('discussion-send').click();
      await page.waitForFunction(() => {
        const note = document.querySelector('[data-testid="discussion-note"]');
        return !!note && /有效/u.test(note.textContent ?? '');
      }, undefined, { timeout: 30000 });
      const note = await dialog.getByTestId('discussion-note').innerText();
      if (/压缩/u.test(note)) break;
      await page.waitForTimeout(200);
    }
    await page.waitForFunction(() => {
      const note = document.querySelector('[data-testid="discussion-note"]');
      return !!note && /压缩/u.test(note.textContent ?? '');
    }, undefined, { timeout: 30000 });
    const note = await dialog.getByTestId('discussion-note').innerText();
    assert.match(note, /已把 \d+ 条旧消息压缩成摘要/u);
    const state = await page.evaluate(async () => (await window.writer.readDiscussion((await window.writer.listProjects())[0].id)).messages);
    const summary = state.find(message => message.role === 'system');
    assert.ok(summary, '应存在一条摘要消息');
    assert.match(summary!.content, /雨夜入城/u, '摘要内容应来自模型');
    const compressed = state.filter(message => message.compressedInto === summary!.id);
    assert.ok(compressed.length >= 1, '原文应被标记为已压缩但仍然存在');
    // 展开原文
    await dialog.getByTestId('discussion-expand').click();
    await dialog.locator('.discussion-originals li').first().waitFor();
    const originals = await dialog.locator('.discussion-originals li').count();
    assert.ok(originals >= 1, '展开后应看到被压缩的原文');
    console.log(`Discussion desktop passed: auto-compressed ${compressed.length} message(s) into a summary, originals still readable, ${calls} model calls.`);
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
