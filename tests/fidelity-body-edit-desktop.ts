import { _electron as electron, type ElectronApplication, type Page, type Locator } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Document, Header, ImageRun, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx';
import JSZip from 'jszip';
import { bodyParagraphTexts, topLevelParagraphs } from '../src/main/docx-fidelity';

const sourceName = '外部保真正文原稿.docx';
const indent = '\u3000\u3000';
const texts = { a: `${indent}甲段保持原样。`, b: `${indent}乙段将删除。`, c: `${indent}丙段仍绑定原格式。`, d: `${indent}丁段有独立格式。`, bookmark: `${indent}书签段受保护。` };
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=', 'base64');

async function originalDocx() {
  const paragraph = (text: string, color: string) => new Paragraph({ children: [new TextRun({ text, color, bold: true })] });
  const bytes = await Packer.toBuffer(new Document({ sections: [{ headers: { default: new Header({ children: [new Paragraph('虚构页眉必须原字节保留')] }) }, children: [
    paragraph(texts.a, 'A11111'), paragraph(texts.b, 'B22222'),
    new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('虚构表格不能移动或丢失')] })] })] }),
    paragraph(texts.c, 'C33333'), new Paragraph({ children: [new ImageRun({ data: image, type: 'png', transformation: { width: 12, height: 12 } })] }),
    paragraph(texts.d, 'D44444'), paragraph(texts.bookmark, 'E55555')
  ] }] }));
  const zip = await JSZip.loadAsync(bytes); let xml = await zip.file('word/document.xml')!.async('string');
  const blocks = topLevelParagraphs(xml);
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]!;
    let raw = xml.slice(block.start, block.end).replace(/^<w:p(?=[\s>])/u, `<w:p w:rsidR="${(index + 1).toString(16).padStart(8, '0')}"`);
    if (block.text === texts.bookmark) raw = raw.replace(/(<w:p\b[^>]*>)/u, '$1<w:bookmarkStart w:id="91" w:name="虚构书签"/>').replace('</w:p>', '<w:bookmarkEnd w:id="91"/></w:p>');
    xml = xml.slice(0, block.start) + raw + xml.slice(block.end);
  }
  zip.file('word/document.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}
async function docxNames(folder: string) { return (await fs.readdir(folder)).filter(name => /\.docx$/iu.test(name)).sort(); }
const rawBlock = (xml: string, text: string) => { const block = topLevelParagraphs(xml).find(value => value.text === text); assert.ok(block, `段落应存在：${text}`); return xml.slice(block.start, block.end); };

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--exe' && path.isAbsolute(args[1]!)), 'Usage: tsx tests/fidelity-body-edit-desktop.ts [--exe <absolute packaged exe>]');
  const executable = args.length ? path.resolve(args[1]!) : createRequire(import.meta.url)('electron') as string;
  const expectedVersion = JSON.parse(await fs.readFile('package.json', 'utf8')).version as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/fidelity-body-ui-057-'));
  const folder = path.join(fixture, 'A虚构正文书'), other = path.join(fixture, 'B同名隔离书');
  await fs.mkdir(folder); await fs.mkdir(other);
  const original = await originalDocx(), originalZip = await JSZip.loadAsync(original), originalXml = await originalZip.file('word/document.xml')!.async('string');
  const sourcePath = path.join(folder, sourceName), otherPath = path.join(other, sourceName);
  await fs.writeFile(sourcePath, original); await fs.writeFile(otherPath, original);
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'app-data'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page, modal!: Locator, input!: Locator;
  const errors: string[] = [];
  const launch = async () => {
    app = await electron.launch({ executablePath: executable, args: args.length ? [] : [path.resolve('out/main/index.js')], env });
    if (args.length) {
      const identity = await app.evaluate(({ app: instance }) => ({ packaged: instance.isPackaged, version: instance.getVersion(), path: instance.getAppPath() }));
      assert.equal(identity.packaged, true); assert.equal(identity.version, expectedVersion);
      assert.equal(await fs.realpath(identity.path), await fs.realpath(path.join(path.dirname(executable), 'resources/app.asar')));
    }
    page = await app.firstWindow(); page.setDefaultTimeout(25000); page.on('pageerror', error => errors.push(error.message));
    modal = page.getByRole('dialog', { name: 'Word 保真副本编辑', exact: true }); input = modal.getByLabel('保真段落正文', { exact: true });
  };
  const openFolder = async () => {
    await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByText(`已打开「${path.basename(folder)}」`, { exact: false }).first().waitFor();
  };
  const openFile = async (name: string) => {
    await page.locator('.chapter-list button').filter({ hasText: name }).click(); await page.getByTestId('fidelity-open').click();
    await input.waitFor(); await page.waitForFunction(() => !(document.getElementById('fidelity-paragraph') as HTMLTextAreaElement)?.disabled);
  };
  let expected = [texts.a, texts.b, texts.c, '', texts.d, texts.bookmark];
  const select = async (text: string) => {
    const index = expected.indexOf(text); assert.ok(index >= 0, `测试段落存在：${text}`);
    await modal.getByRole('button', { name: `编辑第 ${index + 1} 段`, exact: true }).click(); assert.equal(await input.inputValue(), text);
    return index;
  };
  const insert = async (anchor: string, position: 'before' | 'after', text: string) => {
    const index = await select(anchor); await modal.getByTestId(`fidelity-body-insert-${position}`).click();
    assert.equal(await input.inputValue(), indent, '插入段必须预填两个真实 U+3000'); await input.fill(text);
    expected.splice(index + (position === 'after' ? 1 : 0), 0, text);
  };
  const remove = async (text: string) => {
    const index = await select(text); page.once('dialog', dialog => void dialog.accept());
    await modal.getByTestId('fidelity-body-remove').click(); expected.splice(index, 1);
  };
  try {
    await launch(); await openFolder(); await openFile(sourceName);
    assert.equal(await input.inputValue(), texts.a);
    // Protected objects are selectable but cannot be silently deleted along with body text.
    await select(''); assert.equal(await modal.getByTestId('fidelity-body-remove').isDisabled(), true, '图片段禁止删除');
    await select(texts.bookmark); assert.equal(await modal.getByTestId('fidelity-body-remove').isDisabled(), true, '书签段禁止删除');
    await remove(texts.b);
    const temporary = `${indent}临时插入段随后删除。`, beforeNew = `${indent}在新增段前再次插入。`, afterNew = `${indent}在新增段后再次插入。`, afterC = `${indent}丙段之后插入。`;
    await insert(texts.c, 'before', temporary);
    await insert(temporary, 'before', beforeNew);
    await insert(temporary, 'after', afterNew);
    await remove(temporary);
    await insert(texts.c, 'after', afterC);
    const dIndex = await select(texts.d), dChanged = `${indent}丁段修改后仍保留自己的格式。`;
    await input.fill(dChanged); expected[dIndex] = dChanged;
    assert.equal(await modal.getByTestId('docx-structure-open').isDisabled(), true, '正文批量草稿时不能叠加结构修改');
    await page.screenshot({ path: path.join(fixture, 'body-batch-draft.png') });
    assert.equal(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true }))), false);
    await input.press('Control+s'); await modal.waitFor({ state: 'detached' });
    const copies = (await docxNames(folder)).filter(name => name !== sourceName); assert.equal(copies.length, 1, '全部正文动作一次保存只产生一份副本');
    const output = await fs.readFile(path.join(folder, copies[0]!)), copyZip = await JSZip.loadAsync(output), copyXml = await copyZip.file('word/document.xml')!.async('string');
    assert.deepEqual(bodyParagraphTexts(copyXml), expected, '插入/删除/更新后正文顺序与文字准确');
    assert.doesNotMatch(copyXml, /乙段将删除|临时插入段随后删除/u);
    for (const text of [texts.a, texts.c, '', texts.bookmark]) assert.equal(rawBlock(copyXml, text), rawBlock(originalXml, text), '未改的原始正文段保持全部 XML 字节与对象身份');
    assert.match(rawBlock(copyXml, dChanged), /w:rsidR="00000005"/u); assert.match(rawBlock(copyXml, dChanged), /w:color w:val="D44444"/u);
    const sourceTable = /<w:tbl(?=[\s>])[\s\S]*?<\/w:tbl>/u.exec(originalXml)![0]; assert.ok(copyXml.includes(sourceTable), '表格 XML 原字节保留');
    assert.ok(copyXml.indexOf(sourceTable) < copyXml.indexOf(beforeNew), 'C 前插入仍在原表格之后，不移动表格');
    for (const text of [beforeNew, afterNew, afterC]) {
      const raw = rawBlock(copyXml, text); assert.ok(text.startsWith(indent)); assert.ok(!/w:rsidR=|bookmarkStart|w:drawing/u.test(raw), '新增段不克隆段落身份或关联对象');
    }
    assert.deepEqual(Object.keys(copyZip.files).sort(), Object.keys(originalZip.files).sort());
    for (const name of Object.keys(originalZip.files).filter(name => !originalZip.files[name]!.dir && name !== 'word/document.xml')) {
      assert.deepEqual(await copyZip.file(name)!.async('nodebuffer'), await originalZip.file(name)!.async('nodebuffer'), `${name} 原字节保留`);
    }
    assert.deepEqual(await fs.readFile(sourcePath), original); assert.deepEqual(await fs.readFile(otherPath), original); assert.deepEqual(await docxNames(other), [sourceName]);
    // Reopening the new file must display the saved order, with protected objects still present.
    await openFile(copies[0]!);
    for (const text of expected) await select(text);
    await select(texts.bookmark); assert.equal(await modal.getByTestId('fidelity-body-remove').isDisabled(), true);
    await page.screenshot({ path: path.join(fixture, 'body-copy-reopened.png') });
    await modal.getByRole('button', { name: '关闭', exact: true }).click(); await modal.waitFor({ state: 'detached' });

    // Conflict after opening refuses publication while keeping the body-operation draft.
    expected = [texts.a, texts.b, texts.c, '', texts.d, texts.bookmark]; await openFile(sourceName);
    const conflictDraft = `${indent}外变后必须保留的插入草稿。`; await insert(texts.c, 'after', conflictDraft);
    const externalZip = await JSZip.loadAsync(original); externalZip.file('word/document.xml', originalXml.replace('甲段保持原样。', '外部修改过的甲段。'));
    const external = await externalZip.generateAsync({ type: 'nodebuffer' }); await fs.writeFile(sourcePath, external);
    await modal.getByTestId('fidelity-save').click(); await modal.getByRole('alert').filter({ hasText: /版本已变化|原文.*变化/u }).waitFor();
    assert.equal(await input.inputValue(), conflictDraft); assert.equal((await docxNames(folder)).length, 2);
    assert.deepEqual(await fs.readFile(sourcePath), external); assert.deepEqual(await fs.readFile(otherPath), original);
    await page.screenshot({ path: path.join(fixture, 'body-source-conflict.png') });
    page.once('dialog', dialog => void dialog.accept()); await modal.getByRole('button', { name: '取消', exact: true }).click(); await modal.waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(fixture, 'result.json'), JSON.stringify({ schemaVersion: 1, passed: true, checks: ['中间原段删除后其他段XML身份保留', '原段与新增段的前后插入及新增段删除', '真实双U+3000', '图片书签保护', '一次批量只保存一份副本并重开', '其他ZIP部件与表格原字节保留', '外变拒写与输入保留', '同名另一书未改动'] }, null, 2));
    console.log(`Fidelity body edit desktop passed: ${fixture}`);
  } catch (error) {
    if (page && !page.isClosed()) { await page.screenshot({ path: path.join(fixture, 'failure.png') }).catch(() => {}); await fs.writeFile(path.join(fixture, 'failure-page.txt'), await page.locator('body').innerText().catch(() => '')).catch(() => {}); }
    throw error;
  } finally { const remaining = app as ElectronApplication | null; if (remaining) await remaining.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
