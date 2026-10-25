import { _electron as electron, type ElectronApplication, type Page, type Locator } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Document, Footer, Header, ImageRun, Packer, Paragraph, Table, TableCell, TableRow } from 'docx';
import JSZip from 'jszip';
import { bodyParagraphTexts } from '../src/main/docx-fidelity';

const sourceName = '外部结构原稿.docx';
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=', 'base64');
async function externalDocx(book: string) {
  return Packer.toBuffer(new Document({ sections: [
    { headers: { default: new Header({ children: [new Paragraph(`${book}第一页眉`)] }) },
      footers: { default: new Footer({ children: [new Paragraph(`${book}第一页脚`)] }) }, children: [
        new Paragraph(`　　${book}正文第一段。`),
        new Table({ rows: [
          new TableRow({ children: [new TableCell({ children: [new Paragraph('首行甲原件')] }), new TableCell({ children: [new Paragraph('首行乙原件')] })] }),
          new TableRow({ children: [new TableCell({ children: [new Paragraph('第二行甲将删除')] }), new TableCell({ children: [new Paragraph('第二行乙将删除')] })] })
        ] }),
        new Paragraph({ children: [new ImageRun({ data: image, type: 'png', transformation: { width: 12, height: 12 } })] })
      ] },
    { headers: { default: new Header({ children: [new Paragraph(`${book}第二页眉保留`)] }) },
      footers: { default: new Footer({ children: [new Paragraph(`${book}第二页脚`)] }) },
      children: [new Paragraph(`　　${book}正文第二段。`)] }
  ] }));
}

async function docxNames(folder: string) { return (await fs.readdir(folder)).filter(name => /\.docx$/iu.test(name)).sort(); }
async function compareParts(before: Buffer, after: Buffer, changed: string[]) {
  const original = await JSZip.loadAsync(before), copy = await JSZip.loadAsync(after);
  assert.deepEqual(Object.keys(copy.files).sort(), Object.keys(original.files).sort(), '结构编辑不能增删无关ZIP部件');
  for (const name of Object.keys(original.files).filter(name => !original.files[name]!.dir && !changed.includes(name))) {
    assert.deepEqual(await copy.file(name)!.async('nodebuffer'), await original.file(name)!.async('nodebuffer'), `${name} 必须保留原字节`);
  }
  return copy;
}

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/docx-structure-ui-037-'));
  const a = path.join(fixture, 'A虚构结构书'), b = path.join(fixture, 'B同名隔离书'), limitBook = path.join(fixture, 'C千行边界书');
  await fs.mkdir(a); await fs.mkdir(b); await fs.mkdir(limitBook);
  const aOriginal = await externalDocx('A虚构'), bOriginal = await externalDocx('B虚构');
  await fs.writeFile(path.join(a, sourceName), aOriginal); await fs.writeFile(path.join(b, sourceName), bOriginal);
  const limitZip = await JSZip.loadAsync(await externalDocx('C边界'));
  const limitRows = Array.from({ length: 1000 }, (_, index) => `<w:tr><w:tc><w:p><w:r><w:t>边界行${index + 1}</w:t></w:r></w:p></w:tc></w:tr>`).join('');
  limitZip.file('word/document.xml', (await limitZip.file('word/document.xml')!.async('string')).replace(/<w:tbl(?=[\s>])[\s\S]*?<\/w:tbl>/u, `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="4800"/></w:tblGrid>${limitRows}</w:tbl>`));
  const limitOriginal = await limitZip.generateAsync({ type: 'nodebuffer' });
  await fs.writeFile(path.join(limitBook, sourceName), limitOriginal);
  const data = path.join(fixture, '隔离应用数据'), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const errors: string[] = [], results: string[] = [];
  let app: ElectronApplication | null = null, page!: Page, structure!: Locator, fidelity!: Locator;
  const launch = async () => {
    app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [path.resolve('out/main/index.js')], env: { ...env, NOVEL_WRITER_TEST_DATA: data } });
    page = await app.firstWindow(); page.setDefaultTimeout(25_000); page.on('pageerror', error => errors.push(error.message));
    structure = page.getByTestId('docx-structure-panel'); fidelity = page.getByRole('dialog', { name: 'Word 保真副本编辑', exact: true });
  };
  const setOpenFolder = async (folder: string) => { await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder); };
  const openBook = async (folder: string) => {
    await setOpenFolder(folder); await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByText(`已打开「${path.basename(folder)}」`, { exact: false }).first().waitFor();
  };
  const openSource = async () => { await page.locator('.chapter-list button').filter({ hasText: sourceName }).click(); await page.getByTestId('fidelity-open').click(); await fidelity.getByLabel('保真段落正文', { exact: true }).waitFor(); await page.waitForFunction(() => !(document.getElementById('fidelity-paragraph') as HTMLTextAreaElement)?.disabled); };
  const openStructure = async () => {
    await fidelity.getByTestId('docx-structure-open').click(); await structure.waitFor();
    await page.waitForFunction(() => !!document.querySelector('[data-testid="docx-structure-cell"]') && !(document.querySelector('[data-testid="docx-structure-cell"]') as HTMLTextAreaElement).disabled);
  };
  const cell = (row: number, column: number) => structure.locator(`[data-testid="docx-structure-cell"][data-table-index="0"][data-row-index="${row}"][data-cell-index="${column}"][data-paragraph-index="0"]`);
  const header = (part: string) => structure.locator(`[data-testid="docx-structure-header-text"][data-part="${part}"][data-paragraph-index="0"]`);
  const closeEditors = async () => {
    if (await structure.isVisible()) { await structure.getByTestId('docx-structure-close').first().click(); await structure.waitFor({ state: 'detached' }); }
    if (await fidelity.isVisible()) { await fidelity.getByRole('button', { name: '关闭', exact: true }).click(); await fidelity.waitFor({ state: 'detached' }); }
  };
  const waitSaved = async () => {
    await structure.waitFor({ state: 'detached' });
    // A structural result may return to the clean outer editor, or close it after refreshing chapters.
    if (await fidelity.isVisible()) await closeEditors();
  };
  const exitNormally = async () => { const closed = app!.waitForEvent('close', { timeout: 30_000 }); await page.getByRole('button', { name: '保存并退出', exact: true }).click(); await closed; app = null; };
  try {
    await launch(); await openBook(a); await openSource();
    const aId = (await page.evaluate(() => window.writer.listProjects())).find(project => project.root === a)!.id;
    const aInspection = await page.evaluate(async ({ id, file }) => { const manuscript = await window.writer.readChapter(id, file); return window.writer.readDocxStructure(id, file, manuscript.hash); }, { id: aId, file: sourceName });
    assert.equal(aInspection.tables.length, 1); assert.deepEqual(aInspection.tables[0]!.rows.map(row => row.cells.length), [2, 2]);
    assert.deepEqual(aInspection.headers.map(part => part.part).sort(), ['word/footer1.xml', 'word/footer2.xml', 'word/header1.xml', 'word/header2.xml']);
    // Body drafts and structural batches must not compete for the frozen source.
    const body = fidelity.getByLabel('保真段落正文', { exact: true });
    await body.fill('　　尚未保存的正文草稿必须保留。');
    assert.ok(await fidelity.getByTestId('docx-structure-open').isDisabled(), '正文dirty时结构入口必须禁用');
    assert.equal(await body.inputValue(), '　　尚未保存的正文草稿必须保留。');
    page.once('dialog', dialog => void dialog.dismiss()); await fidelity.getByRole('button', { name: '关闭', exact: true }).click();
    assert.ok(await fidelity.isVisible()); assert.equal(await body.inputValue(), '　　尚未保存的正文草稿必须保留。');
    page.once('dialog', dialog => void dialog.accept()); await fidelity.getByRole('button', { name: '关闭', exact: true }).click();
    await fidelity.waitFor({ state: 'detached' }); assert.deepEqual(await docxNames(a), [sourceName]);
    await openSource(); await openStructure();
    await cell(0, 0).fill('界面改写首行甲');
    await structure.locator('[data-testid="docx-structure-add-row"][data-table-index="0"]').click();
    await cell(2, 0).fill('新增行甲'); await cell(2, 1).fill('新增行乙');
    page.once('dialog', dialog => void dialog.accept());
    await structure.locator('[data-testid="docx-structure-remove-row"][data-table-index="0"][data-row-index="1"]').click();
    await header('word/header1.xml').fill('A界面批量改写第一页眉');
    await header('word/footer2.xml').fill('A界面批量改写第二页脚');
    assert.equal(await cell(1, 0).inputValue(), '新增行甲');
    page.once('dialog', dialog => void dialog.dismiss()); await structure.getByTestId('docx-structure-close').first().click();
    assert.ok(await structure.isVisible()); assert.equal(await cell(0, 0).inputValue(), '界面改写首行甲');
    assert.equal(await header('word/header1.xml').inputValue(), 'A界面批量改写第一页眉');
    await page.screenshot({ path: path.join(fixture, 'structure-batch-draft.png') });
    assert.equal(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true }))), false, '结构草稿必须阻止直接关闭');
    await structure.getByTestId('docx-structure-save').click(); await waitSaved();
    const firstCopies = (await docxNames(a)).filter(name => name !== sourceName); assert.equal(firstCopies.length, 1, '多个结构动作只发布一份副本');
    const firstCopy = await compareParts(aOriginal, await fs.readFile(path.join(a, firstCopies[0]!)), ['word/document.xml', 'word/header1.xml', 'word/footer2.xml']);
    const xml = await firstCopy.file('word/document.xml')!.async('string');
    assert.equal((xml.match(/<w:tr[\s>]/gu) ?? []).length, 2);
    assert.match(xml, /界面改写首行甲/u); assert.match(xml, /首行乙原件/u); assert.match(xml, /新增行甲/u); assert.match(xml, /新增行乙/u); assert.doesNotMatch(xml, /第二行[甲乙]将删除/u);
    assert.match(await firstCopy.file('word/header1.xml')!.async('string'), /A界面批量改写第一页眉/u);
    assert.match(await firstCopy.file('word/footer2.xml')!.async('string'), /A界面批量改写第二页脚/u);
    assert.deepEqual(bodyParagraphTexts(xml), bodyParagraphTexts(await (await JSZip.loadAsync(aOriginal)).file('word/document.xml')!.async('string')), '正文及真实U+3000保留');
    assert.deepEqual(await fs.readFile(path.join(a, sourceName)), aOriginal); assert.deepEqual(await docxNames(b), [sourceName]);
    results.push('真实UI批量单元格/增删行/两种页眉页脚一次新副本，原稿/正文/其他ZIP部件原字节保留');

    // External changes reject both explicit save and save/exit without losing the structural draft.
    await openSource(); await openStructure(); await cell(0, 0).fill('冲突时必须保留的结构草稿');
    const externalZip = await JSZip.loadAsync(aOriginal);
    externalZip.file('word/document.xml', (await externalZip.file('word/document.xml')!.async('string')).replace('A虚构正文第一段。', '外部程序已修改第一段。'));
    const external = await externalZip.generateAsync({ type: 'nodebuffer' }); await fs.writeFile(path.join(a, sourceName), external);
    await structure.getByTestId('docx-structure-save').click(); await structure.getByTestId('docx-structure-error').filter({ hasText: /变化|修改/u }).waitFor();
    assert.equal(await cell(0, 0).inputValue(), '冲突时必须保留的结构草稿');
    assert.equal((await docxNames(a)).length, 2); assert.deepEqual(await fs.readFile(path.join(a, sourceName)), external);
    await structure.getByTestId('docx-structure-exit').click();
    const exitConflict = page.getByRole('alert').filter({ hasText: '保存并退出未完成' }).first();
    await exitConflict.waitFor();
    assert.match(await exitConflict.innerText(), /原文版本已变化/u, '保存退出应由原稿指纹变化拒绝，不能只因普通忙期拦截而通过');
    assert.equal(app!.process().exitCode, null); assert.ok(await structure.isVisible()); assert.equal(await cell(0, 0).inputValue(), '冲突时必须保留的结构草稿');
    assert.deepEqual(await fs.readFile(path.join(a, sourceName)), external); assert.deepEqual(await docxNames(b), [sourceName]);
    await page.screenshot({ path: path.join(fixture, 'structure-source-conflict.png') });
    page.once('dialog', dialog => void dialog.accept()); await structure.getByTestId('docx-structure-close').first().click(); await structure.waitFor({ state: 'detached' }); await closeEditors();
    results.push('源外变拒绝另存与保存退出，留窗保留结构草稿与外部原件');

    // Same-name sources in another book retain their independent identity and destination.
    await openBook(b); await openSource(); await openStructure(); await cell(0, 0).fill('B书独立结构修改'); await header('word/header1.xml').fill('B书独立页眉');
    const bId = (await page.evaluate(() => window.writer.listProjects())).find(project => project.root === b)!.id; assert.notEqual(bId, aId);
    await structure.getByTestId('docx-structure-save').click(); await waitSaved();
    const bCopies = (await docxNames(b)).filter(name => name !== sourceName); assert.equal(bCopies.length, 1);
    const bCopy = await compareParts(bOriginal, await fs.readFile(path.join(b, bCopies[0]!)), ['word/document.xml', 'word/header1.xml']);
    assert.match(await bCopy.file('word/document.xml')!.async('string'), /B书独立结构修改/u); assert.doesNotMatch(await bCopy.file('word/document.xml')!.async('string'), /界面改写首行甲|冲突时必须保留/u);
    assert.deepEqual(await fs.readFile(path.join(b, sourceName)), bOriginal); assert.deepEqual(await fs.readFile(path.join(a, sourceName)), external); assert.equal((await docxNames(a)).length, 2);
    results.push('同名外部稿跨书操作的projectId与输出目录隔离');

    // A legal table at the backend row limit remains readable but cannot append another row.
    await openBook(limitBook); await openSource(); await openStructure();
    const limitId = (await page.evaluate(() => window.writer.listProjects())).find(project => project.root === limitBook)!.id;
    const limitInspection = await page.evaluate(async ({ id, file }) => { const manuscript = await window.writer.readChapter(id, file); return window.writer.readDocxStructure(id, file, manuscript.hash); }, { id: limitId, file: sourceName });
    assert.equal(limitInspection.tables[0]!.rows.length, 1000); assert.equal(limitInspection.tables[0]!.editable, true, '合法千行平面表必须可读可编辑');
    assert.equal(await cell(0, 0).inputValue(), '边界行1'); assert.equal(await cell(999, 0).inputValue(), '边界行1000');
    assert.ok(await structure.locator('[data-testid="docx-structure-add-row"][data-table-index="0"]').isDisabled(), '到达1000行上限时必须禁用追加行');
    assert.ok(await structure.getByTestId('docx-structure-save').isDisabled(), '只读入上限表不应制造草稿');
    assert.deepEqual(await docxNames(limitBook), [sourceName]); assert.deepEqual(await fs.readFile(path.join(limitBook, sourceName)), limitOriginal);
    await page.screenshot({ path: path.join(fixture, 'structure-thousand-row-boundary.png') });
    await closeEditors();
    results.push('合法1000行平面表真实读取正常、追加按钮禁用、不产生副本且原稿字节不变');

    // A successful structure save/exit flushes the batch once and reopens the original current manuscript.
    await openBook(a); await openSource(); await openStructure(); await header('word/header2.xml').fill('保存退出成功的新页眉');
    const closing = app!.waitForEvent('close', { timeout: 30_000 }); await structure.getByTestId('docx-structure-exit').click(); await closing; app = null;
    assert.deepEqual(await fs.readFile(path.join(a, sourceName)), external); const aCopies = (await docxNames(a)).filter(name => name !== sourceName); assert.equal(aCopies.length, 2);
    const exitCopyName = aCopies.find(name => name !== firstCopies[0])!, exitCopy = await compareParts(external, await fs.readFile(path.join(a, exitCopyName)), ['word/header2.xml']);
    assert.match(await exitCopy.file('word/header2.xml')!.async('string'), /保存退出成功的新页眉/u);
    await launch(); await openBook(a); await openSource();
    assert.equal(await fidelity.getByLabel('保真段落正文', { exact: true }).inputValue(), '　　外部程序已修改第一段。');
    await fidelity.getByRole('button', { name: '关闭', exact: true }).click(); await fidelity.waitFor({ state: 'detached' }); await exitNormally();
    assert.deepEqual(await fs.readFile(path.join(a, sourceName)), external); assert.deepEqual(errors, []);
    results.push('结构保存退出成功只发布一份新副本，重开现稿仍是外部确认版本');
    await fs.writeFile(path.join(fixture, 'result.json'), JSON.stringify({ schemaVersion: 1, passed: true, aProjectId: aId, bProjectId: bId, checks: results }, null, 2));
    console.log(`DOCX structure UI desktop passed: ${results.join('；')}. Artifacts: ${fixture}`);
  } catch (error) {
    if (page && !page.isClosed()) { await page.screenshot({ path: path.join(fixture, 'failure.png') }).catch(() => {}); await fs.writeFile(path.join(fixture, 'failure-page.txt'), await page.locator('body').innerText().catch(() => '')).catch(() => {}); }
    throw error;
  } finally { const remaining = app as ElectronApplication | null; if (remaining) await remaining.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
