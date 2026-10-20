import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Document, Header, ImageRun, Packer, Paragraph, Table, TableCell, TableRow } from 'docx';
import JSZip from 'jszip';
import { bodyParagraphTexts } from '../src/main/docx-fidelity';

async function main() {
  const fixture = path.resolve('.artifacts', `fidelity-editor-${Date.now()}`), folder = path.join(fixture, '虚构保真界面小说');
  await fs.mkdir(folder, { recursive: true });
  const sourcePath = path.join(folder, '外部完整原稿.docx');
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=', 'base64');
  const original = await Packer.toBuffer(new Document({ sections: [{ headers: { default: new Header({ children: [new Paragraph('虚构页眉保留')] }) }, children: [
    ...Array.from({ length: 53 }, (_, index) => new Paragraph(`　　原稿第${index + 1}段。`)),
    new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('虚构表格保留')] })] })] }),
    new Paragraph({ children: [new ImageRun({ data: image, type: 'png', transformation: { width: 10, height: 10 } })] })
  ] }] }));
  await fs.writeFile(sourcePath, original);
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(20000);
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.locator('.chapter-list button').filter({ hasText: '外部完整原稿.docx' }).click();
    await page.getByTestId('fidelity-open').click();
    const modal = page.getByRole('dialog', { name: 'Word 保真副本编辑', exact: true });
    const input = modal.getByLabel('保真段落正文', { exact: true });
    await input.waitFor(); await page.waitForFunction(() => !(document.getElementById('fidelity-paragraph') as HTMLTextAreaElement)?.disabled);
    assert.equal(await input.inputValue(), '　　原稿第1段。', '外部 HTML 预览必须能进入实际保真编辑');
    assert.equal(await modal.getByRole('button', { name: /^编辑第 \d+ 段$/u }).count(), 50, '长稿分页只展示50段');
    await modal.getByRole('button', { name: '下一页', exact: true }).click();
    await modal.getByRole('button', { name: '编辑第 51 段', exact: true }).click();
    assert.equal(await input.inputValue(), '　　原稿第51段。');
    await modal.getByRole('button', { name: '末尾新增段落', exact: true }).click();
    assert.equal(await input.inputValue(), '\u3000\u3000', '新增段首是两个真实 U+3000');
    await input.fill('　　界面新增末段。');
    await modal.getByRole('button', { name: '上一页', exact: true }).click();
    await modal.getByRole('button', { name: '编辑第 1 段', exact: true }).click();
    await input.fill('　　由真实界面改写的第一段。');
    await page.screenshot({ path: path.join(fixture, 'fidelity-editor.png') });
    assert.equal(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true }))), false, '未保存保真稿阻止浏览器关闭');
    page.once('dialog', dialog => void dialog.dismiss());
    await modal.getByRole('button', { name: '关闭', exact: true }).click();
    assert.ok(await modal.isVisible(), '取消放弃后编辑仍保留');
    await input.press('Control+s');
    await modal.waitFor({ state: 'detached' });
    const copyNames = (await fs.readdir(folder)).filter(name => name.endsWith('.docx') && name !== path.basename(sourcePath));
    assert.equal(copyNames.length, 1);
    const before = await JSZip.loadAsync(original), copy = await JSZip.loadAsync(await fs.readFile(path.join(folder, copyNames[0])));
    const copyXml = await copy.file('word/document.xml')!.async('string');
    const paragraphs = bodyParagraphTexts(copyXml);
    assert.equal(paragraphs[0], '　　由真实界面改写的第一段。');
    assert.equal(paragraphs.at(-1), '　　界面新增末段。');
    assert.match(copyXml, /虚构表格保留/u);
    for (const name of Object.keys(before.files).filter(name => /^word\/(?:media\/|header\d+\.xml$)/u.test(name) && !before.files[name].dir)) {
      assert.deepEqual(await copy.file(name)!.async('uint8array'), await before.file(name)!.async('uint8array'), `${name} 保留原字节`);
    }
    assert.deepEqual(await fs.readFile(sourcePath), original, '点击编辑并另存不能覆盖原稿');

    // A source change after opening must refuse both save and save/exit while preserving the input.
    await page.getByTestId('fidelity-open').click();
    await page.waitForFunction(() => !(document.getElementById('fidelity-paragraph') as HTMLTextAreaElement)?.disabled);
    await input.fill('　　发生外部冲突时保留此修改。');
    const changedZip = await JSZip.loadAsync(original);
    changedZip.file('word/document.xml', (await changedZip.file('word/document.xml')!.async('string')).replace('原稿第1段。', '外部程序修改的第一段。'));
    const externalBytes = await changedZip.generateAsync({ type: 'nodebuffer' }); await fs.writeFile(sourcePath, externalBytes);
    await modal.getByTestId('fidelity-save').click();
    await modal.getByRole('alert').filter({ hasText: /版本已变化/u }).waitFor();
    assert.equal(await input.inputValue(), '　　发生外部冲突时保留此修改。');
    assert.equal((await fs.readdir(folder)).filter(name => name.endsWith('.docx')).length, 2, '冲突不发布新的副本');
    await modal.getByRole('button', { name: '保存副本并退出应用', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '保存并退出未完成' }).waitFor();
    assert.equal(app.process().exitCode, null, '保真副本保存失败必须留窗');
    assert.ok(await modal.isVisible()); assert.equal(await input.inputValue(), '　　发生外部冲突时保留此修改。');
    assert.deepEqual(await fs.readFile(sourcePath), externalBytes);
    page.once('dialog', dialog => void dialog.accept()); await modal.getByRole('button', { name: '取消', exact: true }).click();
    await modal.waitFor({ state: 'detached' });
    await page.locator('.chapter-list button').filter({ hasText: '外部完整原稿.docx' }).click();
    await page.getByTestId('fidelity-open').click();
    await page.waitForFunction(() => !(document.getElementById('fidelity-paragraph') as HTMLTextAreaElement)?.disabled);
    assert.equal(await input.inputValue(), '　　外部程序修改的第一段。');
    await input.fill('　　保存副本并退出后的第一段。');
    const closing = app.waitForEvent('close');
    await modal.getByRole('button', { name: '保存副本并退出应用', exact: true }).click();
    await closing;
    assert.deepEqual(await fs.readFile(sourcePath), externalBytes, '成功保存并退出也不改原稿');
    const copiesAfterExit = (await fs.readdir(folder)).filter(name => name.endsWith('.docx') && name !== path.basename(sourcePath));
    assert.equal(copiesAfterExit.length, 2);
    const outputs = await Promise.all(copiesAfterExit.map(async name => { const zip = await JSZip.loadAsync(await fs.readFile(path.join(folder, name))); return zip.file('word/document.xml')!.async('string'); }));
    assert.ok(outputs.some(xml => xml.includes('保存副本并退出后的第一段。')));
    console.log('Fidelity editor desktop passed: real external DOCX button, 50-paragraph pagination, U+3000, dirty close protection, Ctrl+S copy, preserved tables/images/header/original, source conflict rejection and save/exit failure/success.');
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
