import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// 09: opening a DOCX that carries unsupported content must say so, without touching the file.
async function main() {
  const fixture = path.resolve('.artifacts', `docx-capability-${Date.now()}`), folder = path.join(fixture, '能力报告小说');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    const created = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const chapter = await window.writer.createChapter(id, 'docx');
      await window.writer.saveChapter({ projectId: id, path: chapter.path, expectedHash: chapter.hash,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '普通正文。' }] }] } });
      return chapter.path;
    });
    // Inject a table into the DOCX so the report has something to report.
    const absolute = path.join(folder, created);
    const zip = await JSZip.loadAsync(await fs.readFile(absolute));
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace('</w:body>', '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>表</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body>'));
    await fs.writeFile(absolute, await zip.generateAsync({ type: 'nodebuffer' }));
    await page.getByRole('button', { name: '↻' }).click();
    await page.getByRole('button', { name: created.split(/[\\/]/).pop()!, exact: false }).first().click();
    await page.getByText(/这份 DOCX 有 \d+ 类内容不会随编辑保留/u).waitFor({ timeout: 15000 });
    const banner = await page.getByText(/这份 DOCX 有 \d+ 类内容不会随编辑保留/u).innerText();
    assert.match(banner, /表格/u, `应指出表格不会保留，实际：${banner}`);
    await page.getByText('查看详情').first().click();
    await page.getByText(/每个单元格结构不保留|表格会作为纯文字/u).waitFor();
    console.log('DOCX capability desktop passed: unsupported table reported with details, original file untouched.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
