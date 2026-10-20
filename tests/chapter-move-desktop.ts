import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R08d-2: move the open chapter into a sub-folder; the list, the saved order and the old-path
// binding must all keep working.
async function main() {
  const fixture = path.resolve('.artifacts', `chapter-move-desktop-${Date.now()}`), folder = path.join(fixture, '移动小说');
  const target = path.join(folder, '第一卷'); await fs.mkdir(target, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  try {
    await app.evaluate(({ dialog }, payload) => {
      let call = 0;
      dialog.showOpenDialog = (async () => { call += 1; return call === 1 ? { canceled: false, filePaths: [payload.folder] } : { canceled: false, filePaths: [payload.target] }; }) as typeof dialog.showOpenDialog;
    }, { folder, target });
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    const created = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const chapter = await window.writer.createChapter(id, 'docx');
      await window.writer.saveChapter({ projectId: id, path: chapter.path, expectedHash: chapter.hash,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '虚构移动正文。' }] }] } });
      return chapter.path;
    });
    await page.getByRole('button', { name: '↻' }).click();
    await page.getByRole('button', { name: created.split(/[\\/]/).pop()!, exact: false }).first().click();
    await page.getByRole('button', { name: '移动当前章节…', exact: true }).click();
    await page.getByText(/已移动到/u).waitFor();
    const state = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      return { chapters: await window.writer.chapters(id), order: (await window.writer.chapterOrder(id)).value.paths };
    });
    const moved = state.chapters.map(chapter => chapter.path).find(item => item.startsWith('第一卷'));
    assert.ok(moved, '章节应出现在第一卷目录下');
    assert.ok(state.order.includes(moved), '章节顺序应重指向新位置');
    const onDisk = await fs.readdir(target);
    assert.ok(onDisk.length === 1, '磁盘上应只有一个正文文件在新目录');
    console.log('Chapter move desktop passed: chapter moved into sub-folder, order repointed, list refreshed.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
