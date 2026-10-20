import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R08d-3: whole-book replace is preview-first, then writes through the normal save path.
async function main() {
  const fixture = path.resolve('.artifacts', `book-replace-desktop-${Date.now()}`), folder = path.join(fixture, '替换小说');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      for (const text of ['月钥开启北门。', '雨声里，月钥发亮。']) {
        const chapter = await window.writer.createChapter(id, 'docx');
        await window.writer.saveChapter({ projectId: id, path: chapter.path, expectedHash: chapter.hash,
          content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } });
      }
    });
    await page.getByRole('button', { name: '整书替换…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '整书替换' });
    await dialog.waitFor();
    await dialog.getByLabel('查找内容').fill('月钥');
    await dialog.getByLabel('替换内容').fill('银钥');
    await dialog.getByRole('button', { name: '预览命中', exact: true }).click();
    await dialog.getByText(/预览：共 2 处/u).waitFor();
    await dialog.getByRole('button', { name: '写入替换', exact: true }).click();
    await dialog.getByText(/已替换 2 处，写入 2 章/u).waitFor();
    const texts = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const chapters = await window.writer.chapters(id);
      const out: string[] = [];
      for (const chapter of chapters) out.push(JSON.stringify((await window.writer.readChapter(id, chapter.path)).content));
      return out;
    });
    assert.ok(texts.some(text => text.includes('银钥开启北门')), '第一章应替换');
    assert.ok(texts.some(text => text.includes('银钥发亮')), '第二章应替换');
    assert.ok(!texts.some(text => text.includes('月钥')), '不应残留旧词');
    console.log('Book replace desktop passed: preview counted 2 hits, write replaced both chapters.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
