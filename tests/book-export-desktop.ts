import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import JSZip from 'jszip';

// 导出整本书 ZIP：真实打包，含 manifest，且不覆盖已有文件。
async function main() {
  const fixture = path.resolve('.artifacts', `book-export-desktop-${Date.now()}`), folder = path.join(fixture, '导出书');
  const target = path.join(fixture, '导出结果', '整本.zip');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(25000);
  try {
    await app.evaluate(({ dialog }, payload) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [payload.folder] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: payload.target });
    }, { folder, target });
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const chapter = await window.writer.createChapter(id, 'docx');
      const manuscript = await window.writer.readChapter(id, chapter.path);
      await window.writer.saveChapter({ projectId: id, path: manuscript.path, expectedHash: manuscript.hash,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '　　导出用正文。' }] }] } });
    });
    await page.getByTestId('nas-open').click();
    const dialog = page.getByRole('dialog', { name: 'NAS 连接检查' });
    await dialog.waitFor();
    await dialog.getByTestId('book-export').click();
    const note = dialog.getByTestId('book-export-result');
    await note.waitFor();
    assert.match(await note.innerText(), /已导出 \d+ 个文件/u);
    const zip = await JSZip.loadAsync(await fs.readFile(target));
    const names = Object.keys(zip.files);
    assert.ok(names.some(name => name.endsWith('.docx')), 'ZIP 里应有章节');
    assert.ok(names.includes('manifest.json'), 'ZIP 里应有清单');
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as { entries: unknown[] };
    const fileCount = names.filter(name => name !== 'manifest.json' && !zip.files[name]!.dir).length;
    assert.equal(manifest.entries.length, fileCount, '清单条目数应等于实际文件数（目录不算）');
    // 再导一次同一个路径：必须失败而不是覆盖（界面显示错误）
    await dialog.getByTestId('book-export').click();
    await dialog.getByRole('alert').waitFor();
    console.log('Book export desktop passed: zip written with manifest, second export to the same path refused.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
