import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { encodeDocx } from '../src/main/docx';
import { normalizeParagraphs } from '../src/core/typography';
import { textDocument } from '../src/main/text-import';

// 同步冲突副本：应用只提示、不合并；对照面板把两边并排显示，只读。
async function main() {
  const fixture = path.resolve('.artifacts', `conflict-compare-${Date.now()}`), folder = path.join(fixture, '冲突书');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(25000);
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    const info = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const chapter = await window.writer.createChapter(id, 'docx');
      const manuscript = await window.writer.readChapter(id, chapter.path);
      await window.writer.saveChapter({ projectId: id, path: manuscript.path, expectedHash: manuscript.hash,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '　　当前章节的正文。' }] }] } });
      return { id, path: manuscript.path };
    });
    // 造一份同步软件风格的冲突副本
    const conflictName = info.path.replace(/\.docx$/u, ' (冲突副本 2).docx');
    await fs.writeFile(path.join(folder, conflictName), await encodeDocx(normalizeParagraphs(textDocument('　　冲突副本里的正文。'))));
    // 重新扫描 → 应用应识别出冲突副本并提示
    await page.getByTitle('重新扫描文件夹').click();
    const noticeButton = page.getByTestId('conflict-open');
    await noticeButton.waitFor({ timeout: 20000 });
    await noticeButton.click();
    const dialog = page.getByRole('dialog', { name: '冲突副本对照' });
    await dialog.waitFor();
    await dialog.getByTestId('conflict-item').first().click();
    const copyText = dialog.getByLabel('冲突副本内容');
    await page.waitForFunction(() => /冲突副本里的正文/u.test(document.querySelector('[aria-label="冲突副本内容"]')?.textContent ?? ''), undefined, { timeout: 20000 });
    assert.match(await copyText.innerText(), /冲突副本里的正文/u);
    assert.match(await dialog.getByLabel('当前章节内容').innerText(), /当前章节的正文|没有打开的章节/u);
    // 副本文件本身必须还在，应用没有自动删除或合并
    assert.ok((await fs.readdir(folder)).some(name => name.includes('冲突副本')), '冲突副本不能被应用删除');
    console.log('Conflict compare desktop passed: conflict copy detected, shown side by side, nothing merged or deleted.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
