import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import JSZip from 'jszip';

// R09-1 第三步：表格行增删与页眉改写都另存为新副本，原稿一字不动。
const paragraph = (text: string) => `<w:p><w:pPr><w:jc w:val="both"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
async function buildDocx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>`
    + paragraph('　　结构编辑测试第一段。')
    + `<w:tbl><w:tr><w:tc>${paragraph('表头甲')}</w:tc><w:tc>${paragraph('表头乙')}</w:tc></w:tr></w:tbl>`
    + `</w:body></w:document>`);
  zip.file('word/header1.xml', '<w:hdr><w:p><w:r><w:t>页眉：结构测试</w:t></w:r></w:p></w:hdr>');
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
}

async function main() {
  const fixture = path.resolve('.artifacts', `docx-structure-desktop-${Date.now()}`), folder = path.join(fixture, '结构小说');
  await fs.mkdir(folder, { recursive: true });
  const original = path.join(folder, '结构原稿.docx');
  await fs.writeFile(original, await buildDocx());
  const originalBytes = await fs.readFile(original);
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(25000);
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    const insight = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      return window.writer.docxInsight(id, '结构原稿.docx');
    });
    assert.equal(insight.tables.length, 1);
    assert.equal(insight.tables[0]!.rows, 1);
    assert.equal(insight.tables[0]!.cellsPerRow[0], 2);
    assert.deepEqual(insight.headers, ['word/header1.xml']);
    const appended = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const source = await window.writer.readChapter(id, '结构原稿.docx');
      return window.writer.editDocxStructure(id, source.path, { kind: 'appendRow', tableIndex: 0 }, source.hash);
    });
    assert.equal(appended.changed, 1);
    const header = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const source = await window.writer.readChapter(id, '结构原稿.docx');
      return window.writer.editDocxStructure(id, source.path, { kind: 'header', part: 'word/header1.xml', paragraphs: ['页眉：改写后的结构测试'] }, source.hash);
    });
    assert.equal(header.changed, 1);
    // 原稿必须一字不动，两个操作各自产出新副本
    assert.deepEqual(await fs.readFile(original), originalBytes, '原稿不能被改写');
    const files = (await fs.readdir(folder)).filter(name => name.endsWith('.docx'));
    assert.ok(files.length >= 3, `应有原稿与两份副本：${files.join(', ')}`);
    const rowCopy = files.find(name => name.includes('结构编辑'))!;
    const zip = await JSZip.loadAsync(await fs.readFile(path.join(folder, rowCopy)));
    const xml = await zip.file('word/document.xml')!.async('string');
    assert.equal((xml.match(/<w:tr[\s>]/gu) ?? []).length, 2, '副本里表格应有两行');
    assert.match(xml, /表头甲/u, '原有单元格文字保留');
    const headerCopy = (await fs.readdir(folder)).filter(name => name.includes('结构编辑')).map(name => path.join(folder, name));
    const headers = await Promise.all(headerCopy.map(async file => {
      const inner = await JSZip.loadAsync(await fs.readFile(file));
      return inner.file('word/header1.xml')!.async('string');
    }));
    assert.ok(headers.some(text => /改写后的结构测试/u.test(text)), '应存在改过页眉的副本');
    console.log(`Docx structure desktop passed: table row appended and header rewritten into new copies (${files.length} docx files), original untouched.`);
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
