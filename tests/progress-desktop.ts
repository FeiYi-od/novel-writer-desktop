import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// 写作进度：面板里点一下就能看到总字数/段落与久未更新的章节（按文件 mtime 判断）。
async function main() {
  const fixture = path.resolve('.artifacts', `progress-desktop-${Date.now()}`), folder = path.join(fixture, '进度书');
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
      const first = await window.writer.createChapter(id, 'docx');
      const manuscript = await window.writer.readChapter(id, first.path);
      await window.writer.saveChapter({ projectId: id, path: manuscript.path, expectedHash: manuscript.hash,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '　　进度测试第一章。' }] }] } });
      const second = await window.writer.createChapter(id, 'docx');
      const secondManuscript = await window.writer.readChapter(id, second.path);
      await window.writer.saveChapter({ projectId: id, path: secondManuscript.path, expectedHash: secondManuscript.hash,
        content: { type: 'doc', content: [
          { type: 'paragraph', content: [{ type: 'text', text: '　　第二章第一段。' }] },
          { type: 'paragraph', content: [{ type: 'text', text: '　　第二章第二段。' }] }
        ] } });
      return { id, first: manuscript.path, second: secondManuscript.path };
    });
    // 把第一章的 mtime 改到 40 天前，模拟长期没动
    const old = new Date(Date.now() - 40 * 86_400_000);
    await fs.utimes(path.join(folder, info.first), old, old);

    await page.getByTestId('nas-open').click();
    const dialog = page.getByRole('dialog', { name: 'NAS 连接检查' });
    await dialog.waitFor();
    await dialog.getByTestId('book-progress').click();
    const result = dialog.getByTestId('book-progress-result');
    await result.waitFor();
    const summary = await result.innerText();
    assert.match(summary, /2 章/u, `应统计两章：${summary}`);
    assert.match(summary, /1 章超过 14 天没动/u, `应标出久未更新：${summary}`);
    const rows = await result.locator('tbody tr').allTextContents();
    assert.equal(rows.length, 2, `表格应有两行：${rows.join(' | ')}`);
    assert.ok(rows.some(row => /久未更新/u.test(row)), '久未更新的那一行应有标注');
    assert.ok(rows.every(row => /\d+/.test(row)), '每行应有统计数字');
    console.log('Progress desktop passed: two chapters counted, stale chapter flagged from file mtime.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
