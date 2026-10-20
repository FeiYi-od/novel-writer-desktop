import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import JSZip from 'jszip';

// R09-1: 编辑复杂外部 Word（含表格/图片/页眉）后另存保真副本，结构不丢。
const paragraph = (text: string) => `<w:p><w:pPr><w:jc w:val="both"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
async function buildExternalDocx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>`
    + paragraph('　　外部原稿第一段。')
    + paragraph('　　外部原稿第二段。')
    + `<w:tbl><w:tr><w:tc>${paragraph('表格单元内容')}</w:tc></w:tr></w:tbl>`
    + `<w:p><w:r><w:drawing><wp:inline/></w:drawing></w:r></w:p>`
    + `</w:body></w:document>`);
  zip.file('word/header1.xml', '<w:hdr><w:p><w:r><w:t>页眉：外部书稿</w:t></w:r></w:p></w:hdr>');
  const media = zip.folder('word/media');
  if (!media) throw new Error('media');
  media.file('image1.png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 9, 9]));
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
}

async function main() {
  const fixture = path.resolve('.artifacts', `fidelity-desktop-${Date.now()}`), folder = path.join(fixture, '保真小说');
  await fs.mkdir(folder, { recursive: true });
  const original = path.join(folder, '外部原稿.docx');
  await fs.writeFile(original, await buildExternalDocx());
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(25000);
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    const saved = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const source = await window.writer.readChapter(id, '外部原稿.docx');
      return window.writer.saveFidelityCopy(id, source.path, ['　　改写后的第一段。', '　　外部原稿第二段。', ''], source.hash);
    });
    assert.equal(saved.paragraphs, 3, '正文段落 3 个（表格内段落不计入）');
    assert.equal(saved.changed, 1, '只有第一段真的改了');
    const copy = await fs.readFile(path.join(folder, path.basename(saved.path)));
    const originalBytes = await fs.readFile(original);
    const zip = await JSZip.loadAsync(copy);
    const xml = await zip.file('word/document.xml')!.async('string');
    assert.match(xml, /改写后的第一段/u);
    assert.doesNotMatch(xml, /外部原稿第一段/u);
    assert.match(xml, /外部原稿第二段/u, '未改动的段落保持原样');
    assert.match(xml, /<w:tbl>/u, '表格仍在');
    assert.match(xml, /表格单元内容/u, '表格内文字不被改写');
    assert.match(xml, /<w:drawing>/u, '图片仍在');
    assert.match(xml, /<w:jc w:val="both"\/>/u, '段落属性仍在');
    // 其它部件逐字节相同；原稿未被改动
    const before = await JSZip.loadAsync(originalBytes);
    for (const name of ['word/header1.xml', 'word/media/image1.png']) {
      assert.deepEqual(await zip.file(name)!.async('uint8array'), await before.file(name)!.async('uint8array'), `${name} 必须保持原样`);
    }
    assert.deepEqual(await fs.readFile(original), originalBytes, '原稿不能被覆盖');
    console.log('Fidelity desktop passed: edited text saved to a new copy; table, image, header and paragraph styles preserved.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
