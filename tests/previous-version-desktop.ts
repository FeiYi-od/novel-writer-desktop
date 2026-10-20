import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// 历史版本：保存两次后，能在恢复页看到上一版、预览、取回为新章节，且当前章节不变。
async function main() {
  const fixture = path.resolve('.artifacts', `previous-desktop-${Date.now()}`), folder = path.join(fixture, '历史书');
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
      const first = await window.writer.readChapter(id, chapter.path);
      const saved = await window.writer.saveChapter({ projectId: id, path: first.path, expectedHash: first.hash,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '　　这是第一版正文。' }] }] } });
      // 第二次保存：把第一版留成历史版本
      await window.writer.saveChapter({ projectId: id, path: saved.path, expectedHash: saved.hash,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '　　这是第二版正文。' }] }] } });
      return { id, path: saved.path };
    });
    await page.getByRole('button', { name: '恢复本书草稿' }).click();
    await page.getByRole('heading', { name: '本书草稿恢复' }).waitFor();
    const entry = page.getByTestId('previous-version').first();
    await entry.waitFor();
    await entry.click();
    const preview = page.getByLabel('历史版本预览');
    await preview.waitFor();
    assert.match(await preview.innerText(), /这是第一版正文/u, '预览应是上一版内容');
    await page.getByTestId('version-restore').click();
    const note = page.getByTestId('raw-prune-note');
    await note.waitFor();
    const noteText = await note.innerText();
    assert.match(noteText, /已把历史版本取回为新章节/u, `应提示取回路径：${noteText}`);
    const restoredPath = noteText.replace(/^.*：/u, '').trim();
    const bytes = await fs.readFile(path.join(folder, restoredPath));
    assert.ok(bytes.length > 0, '取回的历史版本文件应存在');
    assert.match(restoredPath, /历史版/u);
    // 当前章节仍是第二版
    const current = await page.evaluate(async target => {
      const manuscript = await window.writer.readChapter(target.id, target.path);
      return JSON.stringify(manuscript.content);
    }, info);
    assert.match(current, /这是第二版正文/u, '当前章节不能被历史版本覆盖');
    console.log('Previous version desktop passed: listed, previewed the earlier text, restored as a new chapter, current chapter untouched.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
