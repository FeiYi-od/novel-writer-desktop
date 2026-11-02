import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--exe' && path.isAbsolute(args[1]!)));
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/detach-safety-'));
  const folder = path.join(fixture, '虚构移除安全书'), local = path.join(fixture, 'profile');
  await fs.mkdir(folder);
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.setHeader('Content-Type', 'text/event-stream');
    response.write('data: {"choices":[{"index":0,"delta":{"content":"虚构进行中候选"}}]}\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let app: ElectronApplication | undefined;
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => typeof item[1] === 'string'));
    delete env.ELECTRON_RUN_AS_NODE; env.NOVEL_WRITER_TEST_DATA = local;
    app = await electron.launch({ executablePath: args[1] ?? createRequire(import.meta.url)('electron'), args: args.length ? [] : [path.resolve('out/main/index.js')], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000);
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByText('已打开「虚构移除安全书」', { exact: false }).waitFor();
    const project = (await page.evaluate(() => window.writer.listProjects()))[0];
    const chapter = await page.evaluate(id => window.writer.createChapter(id), project.id);
    const original = await fs.readFile(path.join(folder, chapter.path));
    // Beginning an exit transaction is also a bounded way to wait for initial reads/writes.
    async function idleToken(target: Page) {
      for (let attempt = 0; attempt < 50; attempt++) {
        try { return await target.evaluate(() => window.writer.beginSaveExit()); }
        catch (error) { assert.match(String(error), /模型任务或文件操作尚未完成/u); await target.waitForTimeout(100); }
      }
      throw new Error('Fixture did not become idle');
    }
    const token = await idleToken(page);
    await assert.rejects(page.evaluate(id => window.writer.removeProject(id), project.id), /正在保存退出/u);
    assert.equal((await page.evaluate(() => window.writer.listProjects())).length, 1);
    await page.evaluate(value => window.writer.cancelSaveExit(value), token);

    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const profiles = await page.evaluate(async baseUrl => {
      const snapshot = await window.writer.aiConnections();
      return window.writer.saveAIConnection({ name: '仅本机虚构移除测试', model: 'fixture', baseUrl, adapter: 'generic', thinking: 'default', timeoutSeconds: 60, contextWindow: 32768, maxOutputTokens: 500, tokenParameter: 'max_tokens' }, snapshot.hash);
    }, `http://127.0.0.1:${address.port}/v1`);
    const connectionId = profiles.connections.at(-1)!.id;
    const request = { projectId: project.id, chapterPath: chapter.path, sourceHash: chapter.hash, connectionId, mode: 'write' as const, instruction: '隔离虚构测试，不调用外部服务' };
    const task = await page.evaluate(value => window.writer.startAI(value), request);
    await assert.rejects(page.evaluate(id => window.writer.removeProject(id), project.id), /模型任务/u);
    assert.equal((await page.evaluate(() => window.writer.listProjects())).length, 1);
    assert.deepEqual(await fs.readFile(path.join(folder, chapter.path)), original);
    await page.evaluate(({ projectId, taskId }) => window.writer.cancelAI(projectId, taskId), { projectId: project.id, taskId: task.id });
    const afterCancel = await idleToken(page); await page.evaluate(value => window.writer.cancelSaveExit(value), afterCancel);

    await page.evaluate(id => {
      (window as any).__removedProjectEvents = 0;
      window.writer.onExternalChapterChange(event => { if (event.projectId === id) (window as any).__removedProjectEvents++; });
    }, project.id);
    await page.evaluate(id => window.writer.removeProject(id), project.id);
    assert.equal((await page.evaluate(() => window.writer.listProjects())).length, 0);
    assert.deepEqual(await fs.readFile(path.join(folder, chapter.path)), original);
    await assert.rejects(page.evaluate(({ id, relative }) => window.writer.readChapter(id, relative), { id: project.id, relative: chapter.path }), /未关联/u);
    const beforeRejectedRequest = requests;
    await assert.rejects(page.evaluate(value => window.writer.startAI(value), request), /未关联/u);
    assert.equal(requests, beforeRejectedRequest, 'Detached project must not start a new model request');
    await fs.writeFile(path.join(folder, chapter.path), original);
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => (window as any).__removedProjectEvents), 0, 'Detached chapter watcher must stop');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(local, 'library.json'), 'utf8')), []);
    console.log(`Project detach safety desktop passed: exit token, running model refusal/cancellation, original preservation, removed-ID request rejection, watcher cleanup. ${fixture}`);
  } finally {
    if (app) await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {});
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
