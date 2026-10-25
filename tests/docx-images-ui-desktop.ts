import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { Document, Footer, Header, ImageRun, Packer, Paragraph } from 'docx';
import JSZip from 'jszip';
import { bodyParagraphTexts } from '../src/main/docx-fidelity';

const sourceName = '外部图片原稿.docx';
function png(width: number, rgba: number[]) {
  const chunk = (name: string, data: Buffer) => {
    const content = Buffer.concat([Buffer.from(name), data]), length = Buffer.alloc(4), crc = Buffer.alloc(4); length.writeUInt32BE(data.length);
    let check = 0xffffffff;
    for (const byte of content) { check ^= byte; for (let bit = 0; bit < 8; bit++) check = (check >>> 1) ^ ((check & 1) ? 0xedb88320 : 0); }
    crc.writeUInt32BE((check ^ 0xffffffff) >>> 0); return Buffer.concat([length, content, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, ...Array.from({ length: width }, () => rgba).flat()]))), chunk('IEND', Buffer.alloc(0))]);
}
const originalImage = png(1, [210, 80, 40, 255]), replacementImage = png(2, [20, 90, 220, 255]);
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
async function externalDocx(book: string, withImages = true) {
  return Packer.toBuffer(new Document({ sections: [{ headers: { default: new Header({ children: [new Paragraph(`${book}页眉原字节`)] }) },
    footers: { default: new Footer({ children: [new Paragraph(`${book}页脚原字节`)] }) }, children: [new Paragraph(`　　${book}正文与双全角空格必须保留。`),
      ...(withImages ? [new Paragraph({ children: [new ImageRun({ data: originalImage, type: 'png', transformation: { width: 24, height: 24 } })] }),
        new Paragraph({ children: [new ImageRun({ data: gif, type: 'gif', transformation: { width: 10, height: 10 } })] })] : [])] }] }));
}
const docxNames = async (folder: string) => (await fs.readdir(folder)).filter(name => /\.docx$/iu.test(name)).sort();
async function verifyCopy(original: Buffer, changed: Buffer, media: string) {
  const source = await JSZip.loadAsync(original), output = await JSZip.loadAsync(changed);
  assert.deepEqual(Object.keys(output.files).sort(), Object.keys(source.files).sort(), '换图不应增加或删除ZIP部件');
  for (const name of Object.keys(source.files).filter(name => !source.files[name]!.dir && name !== media))
    assert.deepEqual(await output.file(name)!.async('nodebuffer'), await source.file(name)!.async('nodebuffer'), `${name} 保留原字节`);
  const bytes = await output.file(media)!.async('nodebuffer');
  assert.notDeepEqual(bytes, await source.file(media)!.async('nodebuffer'));
  assert.deepEqual(bytes.subarray(0, 8), replacementImage.subarray(0, 8)); assert.equal(bytes.readUInt32BE(16), 2); assert.equal(bytes.readUInt32BE(20), 1);
  const xml = await output.file('word/document.xml')!.async('string');
  assert.deepEqual(bodyParagraphTexts(xml), bodyParagraphTexts(await source.file('word/document.xml')!.async('string')));
  assert.ok(bodyParagraphTexts(xml)[0]!.startsWith('　　'), '真实U+3000不能丢失');
}

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/docx-images-ui-038-'));
  const a = path.join(fixture, 'A虚构图片书'), b = path.join(fixture, 'B同名隔离书'), empty = path.join(fixture, 'C无图片书');
  await fs.mkdir(a); await fs.mkdir(b); await fs.mkdir(empty);
  const aOriginal = await externalDocx('A虚构'), bOriginal = await externalDocx('B虚构'), emptyOriginal = await externalDocx('C虚构', false);
  await fs.writeFile(path.join(a, sourceName), aOriginal); await fs.writeFile(path.join(b, sourceName), bOriginal); await fs.writeFile(path.join(empty, sourceName), emptyOriginal);
  const replacement = path.join(fixture, '合法替换图片.png'), replacementJpeg = path.join(fixture, '合法替换图片.jpg'), invalid = path.join(fixture, '伪装图片.png');
  await fs.writeFile(replacement, replacementImage); await fs.writeFile(invalid, '这不是PNG或JPEG图片');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const data = path.join(fixture, '隔离应用数据'), errors: string[] = [], checks: string[] = [];
  let app: ElectronApplication | null = null, page!: Page, fidelity!: Locator, images!: Locator;
  const launch = async () => {
    app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [path.resolve('out/main/index.js')], env: { ...env, NOVEL_WRITER_TEST_DATA: data } });
    page = await app.firstWindow(); page.setDefaultTimeout(25_000); page.on('pageerror', error => errors.push(error.message));
    fidelity = page.getByRole('dialog', { name: 'Word 保真副本编辑', exact: true }); images = page.getByTestId('docx-images-panel');
  };
  const pick = async (file: string | null) => { await app!.evaluate(({ dialog }, value) => { dialog.showOpenDialog = async () => ({ canceled: value === null, filePaths: value === null ? [] : [value] }); }, file); };
  const openBook = async (folder: string) => {
    await pick(folder); await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByText(`已打开「${path.basename(folder)}」`, { exact: false }).first().waitFor();
  };
  const openSource = async () => {
    await page.locator('.chapter-list button').filter({ hasText: sourceName }).click(); await page.getByTestId('fidelity-open').click();
    await fidelity.getByLabel('保真段落正文', { exact: true }).waitFor();
    await page.waitForFunction(() => !(document.getElementById('fidelity-paragraph') as HTMLTextAreaElement)?.disabled);
  };
  const openImages = async () => {
    await fidelity.getByTestId('docx-images-open').click(); await images.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="docx-images-panel"]')?.getAttribute('aria-busy') === 'false');
  };
  const closeEditors = async () => {
    if (await images.isVisible()) { await images.getByTestId('docx-images-close').click(); await images.waitFor({ state: 'detached' }); }
    if (await fidelity.isVisible()) { await fidelity.getByRole('button', { name: '关闭', exact: true }).click(); await fidelity.waitFor({ state: 'detached' }); }
  };
  const waitSaved = async () => { await images.waitFor({ state: 'detached' }); if (await fidelity.isVisible()) await closeEditors(); };
  const deferPicker = async () => { await app!.evaluate(({ dialog }) => {
    const state = globalThis as unknown as { docxImagesPicker?: { calls: number; resolve?: (value: { canceled: boolean; filePaths: string[] }) => void } };
    state.docxImagesPicker = { calls: 0 };
    dialog.showOpenDialog = async () => { state.docxImagesPicker!.calls++; return new Promise<{ canceled: boolean; filePaths: string[] }>(resolve => { state.docxImagesPicker!.resolve = resolve; }); };
  }); };
  const resolvePicker = async (file: string | null) => { await app!.evaluate((_, value) => {
    const state = globalThis as unknown as { docxImagesPicker?: { resolve?: (value: { canceled: boolean; filePaths: string[] }) => void } };
    if (typeof state.docxImagesPicker?.resolve !== 'function') throw new Error('图片文件选择尚未进入等待状态');
    state.docxImagesPicker.resolve({ canceled: value === null, filePaths: value === null ? [] : [value] });
  }, file); };
  const exitNormally = async () => { const closed = app!.waitForEvent('close', { timeout: 30_000 }); await page.getByRole('button', { name: '保存并退出', exact: true }).click(); await closed; app = null; };
  try {
    await launch();
    const jpegBytes = await app!.evaluate(({ nativeImage }, bytes) => {
      const image = nativeImage.createFromBuffer(Buffer.from(bytes));
      if (image.isEmpty()) throw new Error('虚构PNG夹具无法解码');
      return [...image.toJPEG(90)];
    }, [...replacementImage]);
    await fs.writeFile(replacementJpeg, Buffer.from(jpegBytes));
    await openBook(a); await openSource();
    const aId = (await page.evaluate(() => window.writer.listProjects())).find(project => project.root === a)!.id;
    const body = fidelity.getByLabel('保真段落正文', { exact: true });
    await body.fill('　　尚未保存的正文草稿，不能与即时换图竞争。');
    assert.ok(await fidelity.getByTestId('docx-images-open').isDisabled()); assert.equal(await body.inputValue(), '　　尚未保存的正文草稿，不能与即时换图竞争。');
    page.once('dialog', dialog => void dialog.dismiss()); await fidelity.getByRole('button', { name: '关闭', exact: true }).click(); assert.ok(await fidelity.isVisible());
    page.once('dialog', dialog => void dialog.accept()); await fidelity.getByRole('button', { name: '关闭', exact: true }).click(); await fidelity.waitFor({ state: 'detached' });
    await openSource(); await openImages();
    const targets = images.getByTestId('docx-image-target'); assert.equal(await targets.count(), 2);
    const pngTarget = targets.filter({ hasText: /\.png/u }), gifTarget = targets.filter({ hasText: /\.gif/u });
    const media = (await pngTarget.getAttribute('data-name'))!;
    assert.ok(await gifTarget.isDisabled()); assert.match(await gifTarget.innerText(), /只读/u); await pngTarget.click();
    await images.focus(); await page.keyboard.press('Shift+Tab'); assert.equal(await images.getByTestId('docx-images-replace').evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Tab'); assert.equal(await images.getByTestId('docx-images-close').evaluate(element => element === document.activeElement), true);
    await pick(null); await images.getByTestId('docx-images-replace').click(); await images.getByTestId('docx-images-notice').filter({ hasText: '已取消' }).waitFor();
    assert.deepEqual(await docxNames(a), [sourceName]); assert.deepEqual(await fs.readFile(path.join(a, sourceName)), aOriginal);
    await pick(invalid); await images.getByTestId('docx-images-replace').click(); await images.getByTestId('docx-images-error').filter({ hasText: /无法识别|请选择普通 PNG\/JPEG/u }).waitFor();
    assert.ok(await images.isVisible()); assert.deepEqual(await docxNames(a), [sourceName]); assert.deepEqual(await fs.readFile(path.join(a, sourceName)), aOriginal);
    await page.screenshot({ path: path.join(fixture, 'images-invalid-selection.png') });
    checks.push('正文dirty入口禁用、PNG目标选择/GIF只读、Tab循环、取消和伪图片拒绝均保留原稿且无副本');

    await deferPicker(); await images.getByTestId('docx-images-replace').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="docx-images-panel"]')?.getAttribute('aria-busy') === 'true');
    assert.ok(await images.getByTestId('docx-images-close').isDisabled()); assert.ok(await images.getByTestId('docx-images-replace').isDisabled());
    await page.keyboard.press('Escape'); assert.ok(await images.isVisible());
    await page.keyboard.press('Tab'); assert.equal(await images.evaluate(element => element === document.activeElement), true);
    // The panel's busy state reaches App's beforeunload guard through two effects.
    // Wait for that guard rather than racing the local aria-busy DOM commit.
    await page.waitForFunction(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })) === false, undefined, { timeout: 1000 });
    assert.equal(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true }))), false);
    await page.getByRole('button', { name: '保存并退出', exact: true }).evaluate(element => (element as HTMLButtonElement).click());
    await page.getByRole('alert').filter({ hasText: /保存并退出未完成.*正在处理/u }).first().waitFor(); assert.equal(app!.process().exitCode, null);
    assert.equal(await app!.evaluate(() => (globalThis as unknown as { docxImagesPicker: { calls: number } }).docxImagesPicker.calls), 1);
    const externalZip = await JSZip.loadAsync(aOriginal); externalZip.file('word/document.xml', (await externalZip.file('word/document.xml')!.async('string')).replace('A虚构正文', 'A外部修改正文'));
    const external = await externalZip.generateAsync({ type: 'nodebuffer' }); await fs.writeFile(path.join(a, sourceName), external);
    await resolvePicker(replacement); await images.getByTestId('docx-images-error').filter({ hasText: /变化|修改/u }).waitFor();
    assert.ok(await images.isVisible()); assert.deepEqual(await docxNames(a), [sourceName]); assert.deepEqual(await fs.readFile(path.join(a, sourceName)), external);
    await page.screenshot({ path: path.join(fixture, 'images-source-conflict.png') }); await closeEditors();
    checks.push('文件选择忙期拒绝关闭/重复/退出，选择期间外部改稿后拒绝发布且留窗保留外部原件');

    await openSource(); await openImages(); await images.locator(`[data-testid="docx-image-target"][data-name="${media}"]`).click();
    await pick(replacement); await page.screenshot({ path: path.join(fixture, 'images-target-selection.png') });
    await images.getByTestId('docx-images-replace').click(); await waitSaved();
    const aCopies = (await docxNames(a)).filter(name => name !== sourceName); assert.equal(aCopies.length, 1, '成功操作只发布一份换图副本');
    await verifyCopy(external, await fs.readFile(path.join(a, aCopies[0]!)), media);
    assert.deepEqual(await fs.readFile(path.join(a, sourceName)), external); assert.deepEqual(await docxNames(b), [sourceName]);
    checks.push('真实界面选择有效PNG后只另存一份DOCX，仅所选media变更、无关部件/原稿/真实U+3000保留');

    await openBook(b); await openSource(); await openImages();
    const bId = (await page.evaluate(() => window.writer.listProjects())).find(project => project.root === b)!.id; assert.notEqual(bId, aId);
    const bMedia = (await images.getByTestId('docx-image-target').filter({ hasText: /\.png/u }).getAttribute('data-name'))!;
    await pick(replacementJpeg); await images.getByTestId('docx-images-replace').click(); await waitSaved();
    const bCopies = (await docxNames(b)).filter(name => name !== sourceName); assert.equal(bCopies.length, 1);
    await verifyCopy(bOriginal, await fs.readFile(path.join(b, bCopies[0]!)), bMedia);
    assert.deepEqual(await fs.readFile(path.join(a, sourceName)), external); assert.deepEqual(await fs.readFile(path.join(b, sourceName)), bOriginal); assert.equal((await docxNames(a)).length, 2);
    checks.push('真实JPEG经预检/解码转为原PNG目标，同名图片原稿跨书操作的projectId和新副本目录隔离');

    await openBook(empty); await openSource(); await openImages(); await images.getByTestId('docx-images-empty').waitFor();
    assert.ok(await images.getByTestId('docx-images-replace').isDisabled()); await page.keyboard.press('Escape'); await images.waitFor({ state: 'detached' }); await closeEditors();
    assert.deepEqual(await fs.readFile(path.join(empty, sourceName)), emptyOriginal); assert.deepEqual(await docxNames(empty), [sourceName]);
    await exitNormally(); await launch(); await openBook(a); await openSource();
    assert.equal(await fidelity.getByLabel('保真段落正文', { exact: true }).inputValue(), '　　A外部修改正文与双全角空格必须保留。');
    await closeEditors(); await exitNormally(); assert.deepEqual(errors, []);
    checks.push('无内嵌图片状态明确、Escape关闭、保存退出与重开仍是原稿最新版本');
    await fs.writeFile(path.join(fixture, 'result.json'), JSON.stringify({ schemaVersion: 1, passed: true, aProjectId: aId, bProjectId: bId, checks }, null, 2));
    console.log(`DOCX images UI desktop passed: ${checks.join('；')}. Artifacts: ${fixture}`);
  } catch (failure) {
    if (page && !page.isClosed()) { await page.screenshot({ path: path.join(fixture, 'failure.png') }).catch(() => {}); await fs.writeFile(path.join(fixture, 'failure-page.txt'), await page.locator('body').innerText().catch(() => '')).catch(() => {}); }
    throw failure;
  } finally { const remaining = app as ElectronApplication | null; if (remaining) await remaining.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(failure => { console.error(failure); process.exitCode = 1; });
