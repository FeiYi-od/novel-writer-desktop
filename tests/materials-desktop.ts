import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { encodeDocx } from '../src/main/docx';
import { textDocument } from '../src/main/text-import';
import { materialTemplate } from '../src/core/material-conversion';
import { parseCharactersMarkdown, parseNotesMarkdown } from '../src/main/markdown-materials';

async function main() {
  const calls: { url?: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); calls.push({ url: req.url, body });
    if (req.url?.endsWith('/classify')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'success', labels_ratio: { '0': 0.6, '1': 0.3, '2': 0.1 }, softmax_confidence: 0.82, segment_labels: [{ text: body.text, label: 0, conf: 0.9 }] })); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const text = materialTemplate('world', '只有月光能驱动列车。');
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const fixture = path.resolve('.artifacts', `materials-desktop-${Date.now()}`), folder = path.join(fixture, '测试小说甲');
  const userData = path.join(fixture, 'app-data'); await fs.mkdir(folder, { recursive: true });
  const imported = path.join(fixture, '林夏.docx'); await fs.writeFile(imported, await encodeDocx(textDocument('林夏是一位温柔的学生。')));
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: userData } });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000); const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const choose = (file: string) => app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, file);
  const capture = async (name: string) => {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
    await fs.writeFile(path.resolve('.artifacts', name), Buffer.from(png, 'base64'));
  };
  try {
    await choose(folder); await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByText('已打开「测试小说甲」· 0 个正文文件（DOCX / TXT）', { exact: true }).waitFor();
    const projectId = JSON.parse(await fs.readFile(path.join(folder, '小说资料/project.json'), 'utf8')).id as string;
    const materials = path.join(userData, '创作资料', projectId);
    await page.getByLabel('新章节格式').selectOption('txt');
    await page.getByRole('button', { name: '＋ 新建 TXT 章节' }).click();
    await page.locator('.tiptap').fill('第一段正文。\n第二段正文。');
    await page.getByRole('button', { name: '保存 TXT', exact: true }).click();
    await page.getByText('TXT 已保存到所选文件夹', { exact: true }).waitFor();
    const textName = (await fs.readdir(folder)).find(name => name.endsWith('.txt'))!;
    const original = await fs.readFile(path.join(folder, textName)); assert.match(original.toString(), /^　　第一段正文/);
    await page.getByRole('button', { name: '资料转换', exact: true }).click();
    await choose(imported); await page.getByRole('button', { name: '导入 DOCX / TXT 文段' }).click();
    await page.getByLabel('转换原文').filter({ visible: true }).waitFor();
    await page.waitForFunction(() => (document.querySelector('[aria-label="转换原文"]') as HTMLTextAreaElement)?.value.includes('温柔'));
    await page.getByRole('button', { name: '套用模板（不调用 AI）' }).click();
    await page.getByRole('button', { name: '确认保存 Markdown 资料' }).click();
    await page.getByText('已确认保存人物卡.md，请到角色库勾选启用', { exact: true }).waitFor();
    const cards = parseCharactersMarkdown(await fs.readFile(path.join(materials, '人物卡.md'), 'utf8'), projectId);
    assert.equal(cards.cards.length, 1); assert.equal(cards.cards[0].enabled, false); assert.equal(cards.cards[0].name, '林夏');
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByLabel('API 基础地址', { exact: true }).fill(`${baseUrl}/v1`);
    await page.getByLabel('连接名称', { exact: true }).fill('资料整理模型'); await page.getByLabel('模型名称', { exact: true }).fill('mock-material');
    await page.getByRole('button', { name: '保存模型连接', exact: true }).click();
    await page.getByText('模型连接已保存', { exact: true }).waitFor();
    await page.getByRole('button', { name: '资料转换', exact: true }).click();
    await page.getByLabel('资料类型').selectOption('world'); await page.getByLabel('转换原文').fill('只有月光能驱动列车。');
    await page.getByLabel('整理模型').selectOption({ label: '资料整理模型 · mock-material' });
    await page.getByRole('button', { name: '用 AI 整理资料' }).click();
    await page.getByRole('button', { name: '将结果放入保存预览' }).click();
    await page.getByRole('button', { name: '确认保存 Markdown 资料' }).click();
    await page.getByText('已确认追加世界观到创作笔记.md', { exact: true }).waitFor();
    assert.match(parseNotesMarkdown(await fs.readFile(path.join(materials, '创作笔记.md'), 'utf8'), projectId).world, /月光能驱动列车/);
    assert.ok(!JSON.stringify(calls[0].body).includes('温柔的学生')); await capture('materials.png');
    // 朱雀密钥统一在“模型设置 → 朱雀检测连接”里管理
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByRole('button', { name: '朱雀检测连接', exact: true }).click();
    await page.getByLabel('朱雀网关地址').fill(baseUrl); await page.getByLabel('朱雀 API Key').fill('test-zhuque-secret');
    await page.getByRole('button', { name: '保存朱雀连接' }).click(); await page.getByText('朱雀连接已保存（密钥经系统加密，仅本机可用）', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('朱雀 API Key').inputValue(), '');
    await page.getByRole('button', { name: '朱雀检测', exact: true }).click();
    await page.getByRole('button', { name: '发送章节并检测 AI 率' }).click(); await page.getByText('朱雀检测完成', { exact: true }).waitFor();
    await page.getByText('30.0%', { exact: true }).waitFor(); await page.getByText('10.0%', { exact: true }).waitFor();
    assert.equal(calls.at(-1)?.url, '/v1/providers/zhuque-text/classify'); assert.equal(calls.at(-1)?.body.is_merge, false);
    assert.ok(!JSON.stringify(calls.at(-1)?.body).includes('月光')); assert.deepEqual(await fs.readFile(path.join(folder, textName)), original);
    assert.ok(!(await fs.readFile(path.join(userData, 'detection/ai-connections.json'), 'utf8')).includes('test-zhuque-secret'));
    await capture('detection.png');
    const other = path.join(fixture, '测试小说乙'); await fs.mkdir(other); await choose(other);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '朱雀检测', exact: true }).click();
    await page.getByText('尚无检测报告。填写自己的 Makers API Key 后可发起检测。', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log('Materials desktop passed: TXT save, DOCX extraction, confirmed Markdown cards/world, model conversion, encrypted Zhuque connection, ratios, source preservation, cross-book reports.');
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
