import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const RULES = JSON.stringify({ rules: ['短句为主，句子常在三到十二字之间。', '少用形容词，用动作与物件承载情绪。', '对白不加多余说明，留白多于解释。'], limitations: [] });
async function main() {
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw) as { messages: { role: string; content: string }[] };
    const system = body.messages[0]?.content ?? '';
    const text = system.includes('冷峻') ? '雨落在北门上，很轻。她走了。'
      : system.includes('华丽') ? '雨丝如织，金光泼洒，众人惊叹不已，心潮翻涌难息。'
      : RULES;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const fixture = path.resolve('.artifacts', `style-trial-desktop-${Date.now()}`), folder = path.join(fixture, '试写小说');
  await fs.mkdir(folder, { recursive: true });
  const corpusA = path.join(fixture, '语料甲.txt'), corpusB = path.join(fixture, '语料乙.txt');
  await fs.writeFile(corpusA, Array.from({ length: 40 }, (_, index) => `第${index + 1}段。雨又落下来，他站着不动。`).join('\n'), 'utf8');
  await fs.writeFile(corpusB, Array.from({ length: 40 }, (_, index) => `第${index + 1}段。金霞漫过屋脊，众人都屏住了呼吸。`).join('\n'), 'utf8');
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(25000);
  const queue = [folder, corpusA, corpusB];
  try {
    await app.evaluate(({ dialog }, paths) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.shift() ?? ''] });
    }, queue);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByLabel('快捷配置').selectOption({ label: 'DeepSeek' });
    await page.getByLabel('深度思考').selectOption('disabled');
    await page.getByLabel('API 基础地址', { exact: true }).fill(`http://127.0.0.1:${port}/v1`);
    await page.getByLabel('连接名称', { exact: true }).fill('试写模型');
    await page.getByLabel('模型名称', { exact: true }).fill('mock-writer');
    await page.getByLabel('API 密钥', { exact: true }).fill('test-only-key');
    await page.getByRole('button', { name: '保存模型连接', exact: true }).click();
    await page.getByText('模型连接已保存', { exact: true }).waitFor();
    await page.getByRole('button', { name: '文风研习室', exact: true }).click();
    for (const _ of [0, 1]) {
      await page.getByRole('button', { name: '＋ 导入文本', exact: true }).click();
      await page.waitForTimeout(800);
    }
    const sources = page.locator('.source-list input[type="checkbox"]');
    const sourceCount = await sources.count();
    assert.ok(sourceCount >= 2, `参考文本应有 2 份，实际 ${sourceCount}`);
    for (const index of [0, 1]) await sources.nth(index).check();
    // 本机统计规则学习（不调用模型），结果确定，避免夹具依赖模型输出。
    const learn = async (name: string) => {
      await page.getByLabel('文风名称', { exact: true }).fill(name);
      await page.getByRole('button', { name: '分析并生成文风', exact: true }).click();
      await page.locator('.style-card h3', { hasText: name }).first().waitFor({ timeout: 20000 });
    };
    await learn('冷峻');
    await learn('华丽');
    await page.getByRole('button', { name: '写作空间', exact: true }).click();
    await page.getByRole('button', { name: '文风试写比较…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '文风试写比较' });
    await dialog.waitFor();
    const boxes = dialog.locator('.trial-styles input[type="checkbox"]');
    await boxes.nth(0).check(); await boxes.nth(1).check();
    await dialog.getByLabel('试写模型').selectOption({ label: '试写模型 · mock-writer' });
    await dialog.getByLabel('剧情要求').fill('林夏在雨夜抵达北门，第一次使用月钥。');
    await dialog.getByRole('button', { name: '开始比较', exact: true }).click();
    await dialog.getByText(/完成 2\/2 版/u).waitFor({ timeout: 40000 });
    const texts = await dialog.locator('.trial-variants pre').allTextContents();
    assert.equal(texts.length, 2);
    assert.notEqual(texts[0], texts[1], '两版正文应不同');
    assert.equal(await dialog.locator('.trial-table tbody tr').count(), 2);
    console.log('Style trial desktop passed: two learned styles compared with metrics and conclusion.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
