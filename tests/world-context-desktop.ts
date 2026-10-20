import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R19-1: an entry triggered by the chapter text must reach the real provider request body.
async function main() {
  let captured = '';
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    captured = raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '雨落在北门上。' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const fixture = path.resolve('.artifacts', `world-context-${Date.now()}`), folder = path.join(fixture, '注入小说');
  await fs.mkdir(folder, { recursive: true });
  const worldFile = path.join(fixture, '北方世界.json');
  await fs.writeFile(worldFile, JSON.stringify({ entries: { '0': { key: ['北门'], content: '北门在雨夜关闭，守门人不收铜钱。', order: 5 } } }, null, 2), 'utf8');
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  const queue = [folder, worldFile];
  try {
    await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.shift() ?? ''] }); }, queue);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByLabel('快捷配置').selectOption({ label: 'DeepSeek' });
    await page.getByLabel('深度思考').selectOption('disabled');
    await page.getByLabel('API 基础地址', { exact: true }).fill(`http://127.0.0.1:${port}/v1`);
    await page.getByLabel('连接名称', { exact: true }).fill('注入模型');
    await page.getByLabel('模型名称', { exact: true }).fill('mock-world');
    await page.getByLabel('API 密钥', { exact: true }).fill('test-only-key');
    await page.getByRole('button', { name: '保存模型连接', exact: true }).click();
    await page.getByText('模型连接已保存', { exact: true }).waitFor();
    const imported = await page.evaluate(async () => window.writer.importWorldBook((await window.writer.listProjects())[0].id));
    assert.equal(imported?.entries, 1, '世界书应导入成功（模拟文件选择）');
    const started = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const chapter = await window.writer.createChapter(id, 'docx');
      await window.writer.saveChapter({ projectId: id, path: chapter.path, expectedHash: chapter.hash,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '林夏走到北门，握紧月钥。' }] }] } });
      const connection = (await window.writer.aiConnections()).connections[0]!;
      const fresh = await window.writer.readChapter(id, chapter.path);
      const task = await window.writer.startAI({ projectId: id, connectionId: connection.id, chapterPath: chapter.path, sourceHash: fresh.hash, mode: 'write', instruction: '继续写一段' } as never);
      return task.id;
    });
    assert.ok(started);
    for (let index = 0; index < 100 && !captured; index++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(captured, '应收到模型请求');
    const body = JSON.parse(captured) as { messages: { role: string; content: string }[] };
    const system = body.messages.find(message => message.role === 'system')?.content ?? '';
    assert.match(system, /世界书触发条目/u, '系统提示应包含世界书段落');
    assert.match(system, /北门在雨夜关闭/u, '命中的条目内容应出现在请求里');
    console.log('World context desktop passed: triggered entry reached the real provider request.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
