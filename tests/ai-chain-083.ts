import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

// R8：模型链路（本机仿真服务，不联网、不计费）——AI 写作 → 审稿
function sse(text: string) {
  return Buffer.from('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', 'utf8');
}

async function main() {
  const calls: number[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    calls.push(raw.length);
    const mode = raw.includes('审稿') ? 'review' : raw.includes('设定整理助手') ? 'setting' : 'write';
    const text = mode === 'setting'
      ? JSON.stringify({ characters: [{ name: '林夏', personality: '嘴硬心软', goal: '找哥哥' }], world: [{ title: '雾港', content: '终年大雾的海港城', keywords: '雾港,码头' }] })
      : mode === 'review' ? '【夹具审稿】节奏偏慢，建议删减重复描写。' : '【夹具续写】雾港的钟又响了，林夏没有回头。';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(sse(text));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/ai-chain-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const shots = path.join(fixture, 'shots'); await fs.mkdir(shots);
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  const waitTask = async (mode: string, marker: string, id: string) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        const list = await page.evaluate(async project => window.writer.aiTasks(project), id) as { mode: string; status: string; text: string; error: string }[];
        const found = list.find(task => task.mode === mode && task.text.includes(marker));
        if (found) return found;
        const failed = list.find(task => task.mode === mode && task.status === 'failed');
        if (failed) throw new Error(mode + ' 任务失败：' + failed.error);
      } catch (error) { if (error instanceof Error && error.message.includes('任务失败')) throw error; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('等待 ' + mode + ' 任务超时：' + marker);
  };
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(30000);
    page.on('dialog', dialog => { dialog.accept().catch(() => {}); });
    await page.setViewportSize({ width: 1366, height: 768 });
    const projectId = await page.evaluate(async parentDir => (await window.writer.createProject(parentDir, '模型链路书', true)).project.id, parent);
    const snapshot = await page.evaluate(async url => {
      const current = await window.writer.aiConnections();
      return window.writer.saveAIConnection({ name: '夹具模型', baseUrl: url, model: 'fixture-model', adapter: 'generic', thinking: 'default', timeoutSeconds: 30, contextWindow: 8192, maxOutputTokens: 512, tokenParameter: 'max_tokens', apiKey: 'fixture-key' }, current.hash);
    }, 'http://127.0.0.1:' + port + '/v1');
    const connectionId = snapshot.connections[0]!.id;
    await page.reload();
    await page.getByRole('button', { name: '打开作品 模型链路书' }).click();
    await page.locator('.chapter-list button').first().click();
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    await page.getByRole('button', { name: '打开 AI 写作与审稿' }).click();
    await page.getByLabel('写作模型').selectOption(connectionId);
    await page.getByRole('button', { name: '生成正文候选' }).click();
    const writeTask = await waitTask('write', '夹具续写', projectId);
    await page.screenshot({ path: path.join(shots, '1-ai-write.png') });

    const reviewer = page.getByLabel('审稿模型', { exact: true });
    await page.waitForFunction(() => { const element = document.querySelector('select[aria-label="审稿模型"]') as HTMLSelectElement | null; return !!element && !element.disabled; }, undefined, { timeout: 20000 });
    await reviewer.selectOption(connectionId);
    await page.getByRole('button', { name: '审阅已保存章节' }).click();
    const reviewTask = await waitTask('review', '夹具审稿', projectId);
    await page.screenshot({ path: path.join(shots, '2-ai-review.png') });

    // R5：设定提取的模型整理路径（同一条仿真连接）
    await page.getByRole('button', { name: '角色库' }).click();
    await page.getByTestId('setting-extract-open').click();
    await page.getByTestId('setting-text').fill('角色：林夏\n性格：嘴硬心软。\n目标：找哥哥。\n\n地点：雾港\n正文：终年大雾的海港城。\n关键词：雾港,码头');
    await page.getByLabel('设定整理模型').selectOption(connectionId);
    await page.getByTestId('setting-model').click();
    await page.getByLabel('选择 林夏').waitFor({ timeout: 20000 });
    await page.getByTestId('setting-confirm').click();
    await page.waitForFunction(async id => (await window.writer.readCharacters(id)).value.cards.length >= 1, projectId, { timeout: 20000 });
    await page.getByRole('dialog', { name: '从文字设定提取' }).getByRole('button', { name: '关闭' }).click();
    await page.getByRole('dialog', { name: '从文字设定提取' }).waitFor({ state: 'detached', timeout: 10000 });
    await page.screenshot({ path: path.join(shots, '3-setting-model.png') });

    // R3：AI 历史批量删除（界面勾选 → 一次删两条）
    await page.getByRole('button', { name: '写作空间' }).click();
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    await page.getByRole('button', { name: '打开 AI 写作与审稿' }).click();
    const ids = (await page.evaluate(async id => window.writer.aiTasks(id), projectId)).slice(0, 2).map(task => task.id);
    for (const id of ids) await page.getByLabel('选择任务 ' + id).check();
    const before = (await page.evaluate(async id => window.writer.aiTasks(id), projectId)).length;
    await page.getByTestId('ai-task-remove-batch').click();
    await page.waitForFunction(async args => (await window.writer.aiTasks(args.id)).length === args.expect, { id: projectId, expect: before - 2 }, { timeout: 20000 });
    if (calls.length < 3) throw new Error('仿真服务应至少收到三次请求，实际 ' + calls.length);
    console.log(`AI chain passed: 写作、审稿、设定整理各一次完成（仿真服务收到 ${calls.length} 次请求，未联网）；截图 ${shots}`);
  } finally {
    await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {});
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
