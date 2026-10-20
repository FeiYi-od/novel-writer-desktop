import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { textDocument } from '../src/main/text-import';
import type { RichNode } from '../src/shared/contracts';

async function main() {
  const fixture = path.resolve('.artifacts', `chapter-order-desktop-${Date.now()}`);
  const folderA = path.join(fixture, '排序小说甲'), folderB = path.join(fixture, '排序小说乙');
  const local = path.join(fixture, 'app-data'), require = createRequire(import.meta.url);
  await fs.mkdir(folderA, { recursive: true }); await fs.mkdir(folderB);
  let app: ElectronApplication | null = null;
  let page!: Page;
  const errors: string[] = [];
  const launch = async () => {
    app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: local } });
    page = await app.firstWindow(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
  };
  const open = async (folder: string) => {
    await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByText(`已打开「${path.basename(folder)}」`, { exact: false }).waitFor();
    return (await page.evaluate(() => window.writer.listProjects())).find(project => project.root === folder)!.id;
  };
  const create = async (id: string, name: string, content: RichNode, format: 'docx' | 'txt') => {
    return page.evaluate(async ({ id, name, content, format }) => {
      const manuscript = await window.writer.copyChapter(id, content, format);
      return window.writer.renameChapter({ projectId: id, path: manuscript.path, expectedHash: manuscript.hash, name });
    }, { id, name, content, format });
  };
  const visiblePaths = () => page.locator('.chapter-list button').evaluateAll(buttons => buttons.map(button => button.getAttribute('title')));
  const apiPaths = (id: string) => page.evaluate(async id => (await window.writer.chapters(id)).map(chapter => chapter.path), id);
  const orderDialog = () => page.getByRole('dialog', { name: '本书章节排序' });
  const dialogPaths = () => orderDialog().locator('li[data-path]').evaluateAll(rows => rows.map(row => row.getAttribute('data-path')));
  const openOrder = async () => { await page.getByRole('button', { name: '章节排序', exact: true }).click(); await orderDialog().waitFor(); await orderDialog().locator('li[data-path]').first().waitFor(); };
  const saveOrder = async () => { await orderDialog().getByRole('button', { name: '保存顺序', exact: true }).click(); await orderDialog().waitFor({ state: 'hidden' }); };
  const first = '第01章.docx', second = '第02章.txt', third = '第03章.docx';
  try {
    await launch(); const idA = await open(folderA);
    const rich: RichNode = { type: 'doc', content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '虚构排序正文' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '正文甲，原始格式保留。', marks: [{ type: 'bold' }] }] }
    ] };
    await create(idA, '第01章', rich, 'docx');
    await create(idA, '第02章', textDocument('正文乙，TXT原稿保留。'), 'txt');
    await create(idA, '第03章', textDocument('正文丙，DOCX原稿保留。'), 'docx');
    const original = new Map<string, Buffer>();
    for (const file of [first, second, third]) original.set(file, await fs.readFile(path.join(folderA, file)));
    await open(folderA); assert.deepEqual(await visiblePaths(), [first, second, third]);

    // Cancel a staged change without touching either order metadata or manuscripts.
    await openOrder(); assert.deepEqual(await dialogPaths(), [first, second, third]);
    await orderDialog().getByRole('button', { name: `上移 ${second}`, exact: true }).click();
    assert.deepEqual(await dialogPaths(), [second, first, third]);
    page.once('dialog', dialog => dialog.dismiss());
    await orderDialog().getByRole('button', { name: '取消', exact: true }).click();
    assert.deepEqual(await dialogPaths(), [second, first, third], 'declining discard keeps the staged order open');
    page.once('dialog', dialog => dialog.accept());
    await orderDialog().getByRole('button', { name: '取消', exact: true }).click();
    await orderDialog().waitFor({ state: 'hidden' }); assert.deepEqual(await apiPaths(idA), [first, second, third]);

    // Ordering is metadata-only even while the current managed manuscript is dirty.
    await page.locator('.chapter-list button').filter({ hasText: first }).click();
    const editor = page.locator('.tiptap'); await editor.fill('本地尚未保存的正文草稿，排序后仍须保留。');
    await editor.evaluate(element => element.setAttribute('data-order-session', 'unchanged'));
    await openOrder(); await orderDialog().getByRole('button', { name: `上移 ${third}`, exact: true }).click();
    await orderDialog().getByRole('button', { name: `上移 ${third}`, exact: true }).click();
    assert.deepEqual(await dialogPaths(), [third, first, second]); await saveOrder();
    assert.deepEqual(await apiPaths(idA), [third, first, second]); assert.deepEqual(await visiblePaths(), [third, first, second]);
    assert.equal(await editor.getAttribute('data-order-session'), 'unchanged');
    assert.match(await editor.textContent() ?? '', /本地尚未保存的正文草稿/);
    assert.equal(await page.getByRole('button', { name: '保存 DOCX', exact: true }).isEnabled(), true);
    for (const file of [first, second, third]) assert.deepEqual(await fs.readFile(path.join(folderA, file)), original.get(file), `${file} must not be rewritten by ordering`);
    await page.getByRole('button', { name: '保存 DOCX', exact: true }).click();
    await page.getByText('DOCX 已保存到所选文件夹', { exact: true }).waitFor(); original.set(first, await fs.readFile(path.join(folderA, first)));

    // A volume is a filter of the whole-book order, including in the order dialog.
    const book = await page.evaluate(id => window.writer.readBook(id), idA), volumeId = randomUUID();
    await page.evaluate(({ id, book, volumeId, first, third }) => window.writer.saveBook(id, { ...book.value, volumes: [{ id: volumeId, title: '测试分卷', introduction: '', cover: '', chapters: [first, third] }] }, book.hash), { id: idA, book, volumeId, first, third });
    await open(folderA); await page.getByLabel('查看分集').selectOption(volumeId);
    assert.deepEqual(await visiblePaths(), [third, first]); await openOrder(); assert.deepEqual(await dialogPaths(), [third, first, second]);
    await orderDialog().getByRole('button', { name: '取消', exact: true }).click(); await orderDialog().waitFor({ state: 'hidden' });

    // The explicit order follows the application's safe rename binding.
    await page.locator('.chapter-list button').filter({ hasText: first }).click();
    await page.getByRole('button', { name: '重命名', exact: true }).click(); await page.getByLabel('新的章节名称').fill('第一章改名');
    await page.getByRole('button', { name: '确认重命名', exact: true }).click();
    await page.getByText('章节已重命名，原稿归档保留', { exact: true }).waitFor();
    const renamed = '第一章改名.docx'; assert.deepEqual(await apiPaths(idA), [third, renamed, second]);
    assert.deepEqual(await visiblePaths(), [third, renamed]); assert.deepEqual(await fs.readFile(path.join(folderA, renamed)), original.get(first));

    // Persist across process restarts, rather than relying on renderer state.
    await app!.evaluate(({ app: instance }) => instance.exit(0)); app = null;
    await launch(); await open(folderA); assert.deepEqual(await visiblePaths(), [third, renamed, second]);
    const afterRestart = await page.evaluate(id => window.writer.chapterOrder(id), idA);
    assert.equal(afterRestart.value.projectId, idA); assert.equal(afterRestart.value.schemaVersion, 1);

    // A second book can have the same names and an independent order.
    const idB = await open(folderB);
    await create(idB, '第一章改名', textDocument('另一部小说的同名章节。'), 'docx');
    await create(idB, '第02章', textDocument('另一部小说的TXT章节。'), 'txt');
    await open(folderB); const naturalB = await apiPaths(idB); assert.equal(naturalB.length, 2);
    await openOrder(); await orderDialog().getByRole('button', { name: `上移 ${naturalB[1]}`, exact: true }).click(); await saveOrder();
    assert.deepEqual(await apiPaths(idB), [naturalB[1], naturalB[0]]); assert.deepEqual(await apiPaths(idA), [third, renamed, second]);
    const bDocx = await fs.readFile(path.join(folderB, renamed)), bTxt = await fs.readFile(path.join(folderB, second));

    // Another actor changes order metadata while this modal has an older snapshot.
    await open(folderA); await openOrder();
    await orderDialog().getByRole('button', { name: `上移 ${renamed}`, exact: true }).click();
    const latest = await page.evaluate(id => window.writer.chapterOrder(id), idA);
    await page.evaluate(({ id, snapshot, paths }) => window.writer.saveChapterOrder(id, paths, snapshot.hash), { id: idA, snapshot: latest, paths: [second, renamed, third] });
    await orderDialog().getByRole('button', { name: '保存顺序', exact: true }).click(); await orderDialog().getByRole('alert').waitFor();
    assert.deepEqual(await apiPaths(idA), [second, renamed, third]);
    page.once('dialog', dialog => dialog.accept());
    await orderDialog().getByRole('button', { name: '刷新章节', exact: true }).click();
    await page.waitForFunction(({ expected }) => JSON.stringify([...document.querySelectorAll('[role="dialog"] li[data-path]')].map(row => row.getAttribute('data-path'))) === JSON.stringify(expected), { expected: [second, renamed, third] });

    // Missing files keep their stored position; new external files append naturally.
    const displaced = path.join(fixture, '临时移出的第03章.docx'); await fs.rename(path.join(folderA, third), displaced);
    const added = '第00章新入.txt'; await fs.writeFile(path.join(folderA, added), '　　外部新建测试正文。', 'utf8');
    await orderDialog().getByRole('button', { name: '刷新章节', exact: true }).click();
    await page.waitForFunction(({ expected }) => JSON.stringify([...document.querySelectorAll('[role="dialog"] li[data-path]')].map(row => row.getAttribute('data-path'))) === JSON.stringify(expected), { expected: [second, renamed, third, added] });
    await orderDialog().locator('li[data-path]').filter({ hasText: third }).getByText('文件缺失', { exact: true }).waitFor();
    const withMissing = await page.evaluate(id => window.writer.chapterOrder(id), idA);
    assert.equal(withMissing.entries.find(entry => entry.path === third)?.present, false);
    assert.deepEqual(await apiPaths(idA), [second, renamed, added]);
    await orderDialog().getByRole('button', { name: `上移 ${added}`, exact: true }).click();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const png = await app!.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
    await fs.writeFile(path.resolve('.artifacts/chapter-order.png'), Buffer.from(png, 'base64'));
    await saveOrder(); assert.deepEqual(await visiblePaths(), [second, renamed, added]);
    assert.deepEqual((await page.evaluate(id => window.writer.chapterOrder(id), idA)).entries.map(entry => entry.path), [second, renamed, added, third]);
    assert.deepEqual(await fs.readFile(path.join(folderA, renamed)), original.get(first));
    assert.deepEqual(await fs.readFile(path.join(folderA, second)), original.get(second));
    assert.deepEqual(await fs.readFile(displaced), original.get(third));
    assert.deepEqual(await fs.readFile(path.join(folderB, renamed)), bDocx); assert.deepEqual(await fs.readFile(path.join(folderB, second)), bTxt);
    assert.deepEqual(await apiPaths(idB), [naturalB[1], naturalB[0]]); assert.deepEqual(errors, []);
    console.log('Chapter order desktop passed: cancel, metadata-only sorting with dirty stable editor, DOCX/TXT bytes, volume filtering, rename binding, restart, cross-book isolation, stale metadata conflict, missing retention and external append.');
  } catch (error) {
    if (page!) console.error('Chapter order desktop UI:', await page.locator('body').innerText().catch(() => 'window unavailable'));
    throw error;
  } finally {
    const remaining = app as ElectronApplication | null;
    if (remaining) await remaining.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
