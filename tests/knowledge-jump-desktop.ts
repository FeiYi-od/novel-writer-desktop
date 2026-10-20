import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R08d-3 (cross-chapter jump): open a knowledge hit in the editor with the caret on that passage.
async function main() {
  const fixture = path.resolve('.artifacts', `knowledge-jump-${Date.now()}`), folder = path.join(fixture, '跳转小说');
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
      const chapter = await window.writer.createChapter(id, 'docx');
      await window.writer.saveChapter({ projectId: id, path: chapter.path, expectedHash: chapter.hash,
        content: { type: 'doc', content: [
          { type: 'paragraph', content: [{ type: 'text', text: '第一段无关内容。' }] },
          { type: 'paragraph', content: [{ type: 'text', text: '月钥开启北门，只有真正的主人才能转动。' }] }
        ] } });
    });
    await page.getByRole('button', { name: '知识检索', exact: true }).click();
    await page.getByLabel('关键词', { exact: true }).fill('月钥');
    await page.getByRole('button', { name: '重新读取来源' }).click();
    const source = page.locator('.knowledge-sources label').filter({ hasText: '.docx' }).first();
    await source.locator('input[type="checkbox"]').check();
    await page.getByRole('button', { name: '检索本书' }).click();
    await page.getByRole('status').filter({ hasText: '检索完成' }).waitFor();
    await page.getByRole('button', { name: '在编辑器中打开', exact: true }).first().click();
    await page.waitForTimeout(1200);
    console.log('DEBUG alerts:', JSON.stringify(await page.getByRole('alert').allTextContents()));
    console.log('DEBUG viewWriter:', await page.locator('.tiptap').count(), 'titles:', JSON.stringify(await page.locator('h1').allTextContents()));
    await page.locator('.tiptap').waitFor();
    const jumped = await page.locator('.tiptap').getAttribute('data-jump-text');
    assert.ok(jumped && jumped.includes('月钥开启北门'), `编辑器应记录跳转目标，实际：${jumped}`);
    console.log('Knowledge jump desktop passed: hit opened in the editor and the jump target was applied.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
