import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import mammoth from 'mammoth';

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/external-edit-'));
  const folder = path.join(fixture, '虚构小说'); await fs.mkdir(folder);
  const sourcePath = path.join(folder, '外部原稿.docx');
  const source = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun('原始虚构正文。')] })] }] }));
  await fs.writeFile(sourcePath, source);
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--exe' && path.isAbsolute(args[1]!)));
  const app = await electron.launch({ executablePath: args.length ? args[1]! : createRequire(import.meta.url)('electron'), args: args.length ? [] : [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'data') } });
  try {
    if (args.length) { const info = await app.evaluate(({app}) => ({ packaged: app.isPackaged, version: app.getVersion() })); assert.equal(info.packaged, true); assert.equal(info.version, JSON.parse(await fs.readFile('package.json', 'utf8')).version); }
    const page = await app.firstWindow(); page.setDefaultTimeout(30000);
    let confirmed = false;
    await app.evaluate(({dialog}, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.locator('.chapter-list').getByRole('button', { name: '外部原稿.docx' }).click();
    const editor = page.locator('.tiptap'); await editor.waitFor();
    assert.equal(await editor.getAttribute('contenteditable'), 'false');
    await page.setViewportSize({ width: 1000, height: 720 });
    await page.getByTestId('begin-edit-copy').screenshot({ path: path.join(fixture, 'begin-edit.png') });
    page.once('dialog', dialog => void dialog.dismiss());
    await page.getByTestId('begin-edit-copy').click();
    assert.deepEqual((await fs.readdir(folder)).filter(name => name.endsWith('.docx')), ['外部原稿.docx']);
    assert.equal(await editor.getAttribute('contenteditable'), 'false');
    page.on('dialog', dialog => { confirmed = true; void dialog.accept(); });
    await page.getByTestId('begin-edit-copy').click();
    await page.getByText('已创建可编辑 DOCX 副本，原文件保留').waitFor();
    assert.equal(confirmed, true);
    assert.equal(await editor.getAttribute('contenteditable'), 'true');
    await editor.fill('　　修改后的虚构正文。');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.match(await editor.innerText(), /原始虚构正文/u);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    assert.match(await editor.innerText(), /修改后的虚构正文/u);
    await page.getByRole('button', { name: '保存 DOCX', exact: true }).click();
    await page.getByText('DOCX 已保存到所选文件夹', { exact: true }).waitFor();
    assert.deepEqual(await fs.readFile(sourcePath), source);
    const copies = (await fs.readdir(folder)).filter(name => name.endsWith('.docx') && name !== path.basename(sourcePath));
    assert.equal(copies.length, 1);
    const output = await mammoth.extractRawText({ path: path.join(folder, copies[0]!) });
    assert.match(output.value, /\u3000\u3000修改后的虚构正文/u);
    console.log('External DOCX edit desktop passed: confirmed editable copy, undo, redo, save, original bytes and real paragraph spaces.');
  } finally { await app.evaluate(({app}) => app.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
