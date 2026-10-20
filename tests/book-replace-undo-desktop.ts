import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R08d-3 (undo): after a whole-book replace the UI can restore the previous bytes.
async function main() {
  const fixture = path.resolve('.artifacts', `book-replace-undo-${Date.now()}`), folder = path.join(fixture, '撤销小说');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    const original = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const chapter = await window.writer.createChapter(id, 'docx');
      await window.writer.saveChapter({ projectId: id, path: chapter.path, expectedHash: chapter.hash,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '月钥开启北门。' }] }] } });
      return (await window.writer.readChapter(id, chapter.path)).path;
    });
    await page.getByRole('button', { name: '整书替换…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '整书替换' });
    await dialog.waitFor();
    await dialog.getByLabel('查找内容').fill('月钥');
    await dialog.getByLabel('替换内容').fill('银钥');
    await dialog.getByRole('button', { name: '预览命中', exact: true }).click();
    await dialog.getByRole('button', { name: '写入替换', exact: true }).click();
    await dialog.getByText(/已替换 1 处，写入 1 章/u).waitFor();
    await dialog.getByRole('button', { name: '撤销本次替换', exact: true }).click();
    await page.getByText(/已恢复 1 章/u).waitFor();
    const text = await page.evaluate(async (chapterPath) => {
      const id = (await window.writer.listProjects())[0].id;
      return JSON.stringify((await window.writer.readChapter(id, chapterPath)).content);
    }, original);
    assert.match(text, /月钥开启北门/u, '撤销后应回到替换前的正文');
    assert.doesNotMatch(text, /银钥/u);
    console.log('Book replace undo desktop passed: replace then undo restored the original text.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
