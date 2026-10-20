import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R23-5: version bump only on real edits, history kept, template fills the writing instruction.
async function main() {
  const fixture = path.resolve('.artifacts', `prompts-desktop-${Date.now()}`), folder = path.join(fixture, '提示词小说');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  const clickEnabled = async (selector: string) => {
    await page.waitForFunction(sel => { const el = document.querySelector(sel) as HTMLButtonElement | null; return !!el && !el.disabled; }, selector, { timeout: 15000 });
    await page.click(selector);
  };
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const chapter = await window.writer.createChapter(id, 'docx');
      await window.writer.saveChapter({ projectId: id, path: chapter.path, expectedHash: chapter.hash,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '虚构正文。' }] }] } });
    });
    await page.getByRole('button', { name: '提示词库…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '提示词库' });
    await dialog.waitFor();
    // 用精确标签：新模板内容 与 模板内容 会前缀互相匹配，精确匹配避免歧义。
    await dialog.getByLabel('新模板名称', { exact: true }).fill('雨夜续写');
    await dialog.getByLabel('新模板内容', { exact: true }).fill('按当前章节续写，保持冷色描写。');
    await clickEnabled('[data-testid="prompt-add"]');
    await clickEnabled('[data-testid="prompt-save"]');
    await dialog.getByText('提示词库已保存', { exact: true }).waitFor();
    const first = await page.evaluate(async () => (await window.writer.readPrompts((await window.writer.listProjects())[0].id)).templates.map(item => item.version));
    assert.deepEqual(first, [1]);
    await dialog.getByLabel('模板内容', { exact: true }).fill('按当前章节续写，保持冷色描写，克制对白。');
    await clickEnabled('[data-testid="prompt-save"]');
    await dialog.getByText('提示词库已保存', { exact: true }).waitFor();
    const saved = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const snapshot = await window.writer.readPrompts(id);
      return snapshot.templates.map(item => ({ version: item.version, versions: item.versions.length }));
    });
    assert.equal(saved[0].version, 2, '改动内容应升到 v2');
    assert.equal(saved[0].versions, 1, '应保留一份历史版本');
    await clickEnabled('[data-testid="prompt-fill"]');
    await page.getByLabel('写作要求', { exact: true }).waitFor();
    // 填入动作跨视图切换（面板关闭 → AI 写作页），给它一点时间落到位，避免时序抖动。
    await page.waitForFunction(() => /冷色描写/u.test((document.querySelector('[aria-label="写作要求"]') as HTMLTextAreaElement | null)?.value ?? ''), undefined, { timeout: 15000 });
    assert.match(await page.getByLabel('写作要求', { exact: true }).inputValue(), /冷色描写，克制对白/u);
    console.log('Prompt library desktop passed: v2 with history, template filled into the instruction.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
