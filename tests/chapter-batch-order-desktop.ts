import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R08d-4 (batch part): select a chapter and move it to the front, then persist the new order.
async function main() {
  const fixture = path.resolve('.artifacts', `chapter-batch-${Date.now()}`), folder = path.join(fixture, '批量排序小说');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    const created: string[] = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const paths: string[] = [];
      for (const name of ['第一章', '第二章', '第三章']) {
        const chapter = await window.writer.createChapter(id, 'docx');
        await window.writer.saveChapter({ projectId: id, path: chapter.path, expectedHash: chapter.hash,
          content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `${name}的虚构正文。` }] }] } });
        paths.push(chapter.path);
      }
      return paths;
    });
    assert.equal(created.length, 3);
    await page.getByRole('button', { name: '章节排序', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '本书章节排序' });
    await dialog.waitFor();
    await dialog.locator('li[data-path]').first().waitFor();
    const before: string[] = await dialog.locator('li[data-path]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.path ?? ''));
    assert.equal(before.length, 3);
    const last = before[2], lastName = last.split(/[\\/]/).pop()!;
    await dialog.getByLabel(`选择 ${lastName}`).check();
    await dialog.getByRole('button', { name: '移到最前', exact: true }).click();
    await dialog.getByRole('button', { name: '保存顺序', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const saved: string[] = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      return (await window.writer.chapterOrder(id)).value.paths;
    });
    assert.equal(saved[0], last, '被选中的章节应排到最前并已保存');
    assert.deepEqual([...saved].sort(), [...before].sort(), '批量移动不得增删章节');

    // Exact move (keyboard/typing equivalent of dragging): move the last row to position 1.
    await page.getByRole('button', { name: '章节排序', exact: true }).click();
    await dialog.waitFor();
    await dialog.locator('li[data-path]').first().waitFor();
    const exactBefore: string[] = await dialog.locator('li[data-path]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.path ?? ''));
    await dialog.getByLabel('移动起点').fill(String(exactBefore.length));
    await dialog.getByLabel('移动终点').fill('1');
    await dialog.getByRole('button', { name: '移动到该位置', exact: true }).click();
    await dialog.getByRole('button', { name: '保存顺序', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const exact: string[] = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      return (await window.writer.chapterOrder(id)).value.paths;
    });
    assert.equal(exact[0], exactBefore.at(-1), '精确移动应把指定章节放到第 1 位');
    assert.deepEqual([...exact].sort(), [...exactBefore].sort(), '精确移动不得增删章节');
    console.log('Chapter batch reorder desktop passed: batch move and exact move both persisted, no chapter lost.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
