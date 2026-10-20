import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R08d-1: an external edit to a chapter file is announced, and switching books does not leak the
// previous book's notice.
async function main() {
  const fixture = path.resolve('.artifacts', `external-watch-${Date.now()}`);
  const bookA = path.join(fixture, '监听小说甲'), bookB = path.join(fixture, '监听小说乙');
  await fs.mkdir(bookA, { recursive: true }); await fs.mkdir(bookB, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, bookA);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const chapter = await window.writer.createChapter(id, 'txt');
      await window.writer.saveChapter({ projectId: id, path: chapter.path, expectedHash: chapter.hash,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '虚构监听正文。' }] }] } });
    });
    // Let the watcher attach, then edit the file outside the app.
    await page.waitForTimeout(1200);
    const files = (await fs.readdir(bookA)).filter(name => name.endsWith('.txt'));
    assert.ok(files.length >= 1);
    await fs.writeFile(path.join(bookA, files[0]), '虚构监听正文，外部改了。', 'utf8');
    await page.getByText(/磁盘上的章节被外部修改/u).waitFor({ timeout: 15000 });
    assert.match(await page.getByText(/磁盘上的章节被外部修改/u).innerText(), new RegExp(files[0].replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    await page.getByRole('button', { name: '忽略', exact: true }).click();
    console.log('External chapter change desktop passed: disk edit announced with the file name.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
