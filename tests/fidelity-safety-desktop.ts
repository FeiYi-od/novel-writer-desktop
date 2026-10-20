import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { bodyParagraphTexts } from '../src/main/docx-fidelity';

async function main() {
  const fixture = path.resolve('.artifacts', `fidelity-safety-${Date.now()}`), folder = path.join(fixture, '虚构安全书');
  await fs.mkdir(folder, { recursive: true });
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:p><w:pPr><w:jc w:val="both"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>尾段。</w:t><w:drawing><wp:inline/></w:drawing></w:r></w:p></w:body></w:document>');
  zip.file('word/media/image.png', Uint8Array.from([137, 80, 78, 71, 1, 2, 3]));
  const original = await zip.generateAsync({ type: 'uint8array' }), source = path.join(folder, '含空段图片.docx');
  await fs.writeFile(source, original);
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(20000);
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    const id = await page.evaluate(async () => (await window.writer.listProjects())[0].id);
    const copied = await page.evaluate(async target => {
      const source = await window.writer.readChapter(target, '含空段图片.docx');
      return window.writer.saveFidelityCopy(target, source.path, ['　　空段已填写。', '尾段。', '　　新段。'], source.hash);
    }, id);
    const next = await JSZip.loadAsync(await fs.readFile(path.join(folder, copied.path)));
    const xml = await next.file('word/document.xml')!.async('string');
    assert.deepEqual(bodyParagraphTexts(xml), ['　　空段已填写。', '尾段。', '　　新段。']);
    assert.equal((xml.match(/<w:drawing>/gu) ?? []).length, 1, '新增段不能复制原段图片');
    const filesBefore = await fs.readdir(folder);
    const refused = await page.evaluate(async target => {
      const source = await window.writer.readChapter(target, '含空段图片.docx');
      try { await window.writer.saveFidelityCopy(target, source.path, ['只剩一段'], source.hash); return ''; }
      catch (error) { return String(error); }
    }, id);
    assert.match(refused, /无法安全删除/u, '不能静默删除图片锚点');
    assert.deepEqual(await fs.readdir(folder), filesBefore, '拒绝操作时不发布残缺副本');
    assert.deepEqual(new Uint8Array(await fs.readFile(source)), original, '所有操作后原稿逐字节不变');
    assert.deepEqual(await next.file('word/media/image.png')!.async('uint8array'), await zip.file('word/media/image.png')!.async('uint8array'));
    console.log('Fidelity safety desktop passed: empty paragraph written, added paragraph does not duplicate image, unsafe deletion refused, original bytes unchanged.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
