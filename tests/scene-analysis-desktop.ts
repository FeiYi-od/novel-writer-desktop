import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R25b-2: the scene panel reads the open chapter and reports counted metrics + suggestions.
async function main() {
  const fixture = path.resolve('.artifacts', `scene-desktop-${Date.now()}`), folder = path.join(fixture, '场景小说');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    const chapterPath = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const chapter = await window.writer.createChapter(id, 'docx');
      const lines = ['“你来了。”她说道。', '“嗯。”他答道。', '“雨很大。”她说道。', '“我知道。”他答道。'];
      await window.writer.saveChapter({ projectId: id, path: chapter.path, expectedHash: chapter.hash,
        content: { type: 'doc', content: lines.map(line => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })) } });
      return chapter.path;
    });
    await page.getByRole('button', { name: '↻' }).click();
    const chapters = await page.evaluate(async () => (await window.writer.chapters((await window.writer.listProjects())[0].id)).map(chapter => chapter.path));
    const firstName = await page.evaluate(async (target: string) => (await window.writer.chapters((await window.writer.listProjects())[0].id)).find(chapter => chapter.path === target)?.name ?? '', chapterPath);
    assert.ok(chapters.includes(chapterPath));
    assert.ok(firstName);
    await page.getByRole('button', { name: firstName }).first().click();
    await page.getByTestId('scene-open').click();
    const dialog = page.getByRole('dialog', { name: '场景分析' });
    await dialog.waitFor();
    const summary = await dialog.innerText();
    assert.match(summary, /对白为主/u, `应识别为对白场景，实际：${summary.slice(0, 120)}`);
    assert.match(summary, /修改建议/u);
    const cells = await dialog.locator('.scene-table td').allTextContents();
    assert.ok(cells.some(cell => /%$/u.test(cell)), '应有百分比指标');
    assert.ok((await dialog.locator('.scene-suggestions li').count()) >= 1, '提示语过密的样本应至少给出一条建议');
    console.log('Scene analysis desktop passed: dialogue scene detected with counted metrics and suggestions.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
