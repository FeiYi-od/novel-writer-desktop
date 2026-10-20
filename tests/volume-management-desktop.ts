import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { textDocument } from '../src/main/text-import';

async function main() {
  const fixture = path.resolve('.artifacts', `volume-management-desktop-${Date.now()}`), folderA = path.join(fixture, '虚构分集甲'), folderB = path.join(fixture, '虚构分集乙'), local = path.join(fixture, 'app-data');
  await fs.mkdir(folderA, { recursive: true }); await fs.mkdir(folderB);
  const require = createRequire(import.meta.url); let app: ElectronApplication | null = null; let page!: Page; const errors: string[] = [];
  const launch = async () => { app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: local } }); page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message)); };
  const open = async (folder: string) => { await app!.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, folder); await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click(); await page.getByText(`已打开「${path.basename(folder)}」`, { exact: false }).waitFor(); return (await page.evaluate(() => window.writer.listProjects())).find(p => p.root === folder)!.id; };
  const create = async (id: string, name: string, format: 'docx' | 'txt') => page.evaluate(async ({ id, name, format, content }) => { const saved = await window.writer.copyChapter(id, content, format); return window.writer.renameChapter({ projectId: id, path: saved.path, expectedHash: saved.hash, name }); }, { id, name, format, content: textDocument(`虚构原稿${name}，分集操作不得修改。`) });
  const modal = () => page.getByRole('dialog', { name: '封面与分集管理' });
  const edit = async (title: string) => { await page.getByRole('button', { name: '我的书架', exact: true }).click(); await page.getByRole('button', { name: `编辑作品 ${title}`, exact: true }).click(); await modal().waitFor(); await page.waitForFunction(() => !document.querySelector('[role="dialog"] [role="status"]')); };
  const rowIds = () => modal().locator('.volume-row').evaluateAll(rows => rows.map(row => row.getAttribute('data-volume-id')));
  const save = async () => { await modal().getByRole('button', { name: '保存书架资料', exact: true }).click(); await modal().waitFor({ state: 'hidden' }); };
  const close = async (discard = false) => { if (discard) page.once('dialog', d => d.accept()); await modal().getByRole('button', { name: '关闭', exact: true }).click(); await modal().waitFor({ state: 'hidden' }); };
  const read = (id: string) => page.evaluate(id => window.writer.readBook(id), id);
  const exitSaved = async () => { const closed = app!.waitForEvent('close'); const button = page.getByRole('button', { name: '保存并退出', exact: true }); await button.focus(); await button.press('Enter'); await closed; app = null; };
  try {
    await launch(); const idA = await open(folderA);
    const chapter1 = await create(idA, '第01章', 'docx'), chapter2 = await create(idA, '第02章', 'txt'), chapter3 = await create(idA, '第03章', 'docx');
    const originals = new Map<string, Buffer>(); for (const chapter of [chapter1, chapter2, chapter3]) originals.set(chapter.path, await fs.readFile(path.join(folderA, chapter.path)));
    const coverBytes = Buffer.from(await app!.evaluate(({ nativeImage }) => nativeImage.createFromBitmap(Buffer.from([40, 90, 50, 255, 60, 120, 70, 255, 50, 100, 60, 255, 70, 130, 80, 255]), { width: 2, height: 2 }).toPNG().toString('base64')), 'base64'), coverFile = path.join(fixture, '虚构封面.png'); await fs.writeFile(coverFile, coverBytes);
    await app!.evaluate(({ dialog }, coverFile) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [coverFile] }); }, coverFile);
    const cover = await page.evaluate(id => window.writer.importCover(id), idA); assert.ok(cover);
    const ids = [randomUUID(), randomUUID(), randomUUID()], initial = await read(idA);
    await page.evaluate(({ id, initial, ids, paths, cover }) => window.writer.saveBook(id, { ...initial.value, volumes: [
      { id: ids[0], title: '起航卷', introduction: '虚构甲卷引言', cover, chapters: [paths[0], '目录缺失/保留映射.docx'] },
      { id: ids[1], title: '远行卷', introduction: '虚构乙卷引言', cover: '', chapters: [paths[1]] },
      { id: ids[2], title: '归途卷', introduction: '虚构丙卷引言', cover: '', chapters: [paths[2]] }
    ] }, initial.hash), { id: idA, initial, ids, paths: [chapter1.path, chapter2.path, chapter3.path], cover: cover!.asset });
    await open(folderA); await edit(path.basename(folderA)); assert.deepEqual(await rowIds(), ids);
    // Native cover selection is asynchronous: the opened book and target remain frozen.
    await app!.evaluate(({ dialog }, coverFile) => { dialog.showOpenDialog = async () => { await new Promise(resolve => setTimeout(resolve, 1500)); return { canceled: false, filePaths: [coverFile] }; }; }, coverFile);
    await modal().getByRole('button', { name: '选择小说封面', exact: true }).click();
    assert.equal(await modal().getByLabel('小说名称', { exact: true }).isDisabled(), true);
    assert.equal(await modal().getByRole('button', { name: '删除分集 起航卷', exact: true }).isDisabled(), true);
    assert.equal(await modal().getByRole('button', { name: '关闭', exact: true }).isDisabled(), true);
    const exitWhileCover = page.getByRole('button', { name: '保存并退出', exact: true }); await exitWhileCover.focus(); await exitWhileCover.press('Enter');
    await page.getByRole('alert').filter({ hasText: '保存并退出未完成' }).first().waitFor(); assert.equal(app!.process().exitCode, null);
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[role="dialog"] button')?.disabled);
    await modal().getByRole('img', { name: `${path.basename(folderA)}封面`, exact: true }).waitFor();
    // Single and selected block movement keep stable relative order.
    await modal().getByRole('button', { name: '上移分集 归途卷', exact: true }).click(); assert.deepEqual(await rowIds(), [ids[0], ids[2], ids[1]]);
    await modal().getByRole('button', { name: '下移分集 归途卷', exact: true }).click();
    await modal().getByLabel('选择分集 远行卷', { exact: true }).check(); await modal().getByLabel('选择分集 归途卷', { exact: true }).check();
    await modal().getByRole('button', { name: '上移所选分集', exact: true }).click(); assert.deepEqual(await rowIds(), [ids[1], ids[2], ids[0]]);
    await modal().getByRole('button', { name: '下移所选分集', exact: true }).click(); assert.deepEqual(await rowIds(), ids);
    await modal().getByRole('button', { name: '清空分集选择', exact: true }).click();
    // Cancel does not delete even staged metadata. Confirm removes only metadata.
    page.once('dialog', d => { assert.match(d.message(), /正文文件和封面图片原件全部保留/); return d.dismiss(); });
    await modal().getByRole('button', { name: '删除分集 起航卷', exact: true }).click(); assert.deepEqual(await rowIds(), ids);
    // Full-path chapter selection, filter selection, move, unassign, and single assignment remain compatible.
    await modal().getByRole('button', { name: /01 · 起航卷/ }).click();
    await modal().getByLabel('筛选分集管理章节', { exact: true }).fill('第0'); await modal().getByRole('button', { name: '选择筛选章节', exact: true }).click();
    await modal().getByRole('button', { name: '归入当前分集', exact: true }).click();
    await modal().getByRole('button', { name: '清空章节选择', exact: true }).click(); await modal().getByLabel(`选择章节 ${chapter2.path}`, { exact: true }).check();
    await modal().getByLabel('批量目标分集', { exact: true }).selectOption(ids[1]); await modal().getByRole('button', { name: '移到所选分集', exact: true }).click();
    await modal().getByRole('button', { name: '移出分集', exact: true }).click(); await modal().getByLabel(`本集章节 ${chapter2.path}`, { exact: true }).check();
    await save(); let state = await read(idA); assert.deepEqual(state.value.volumes[0].chapters, [path.join('目录缺失', '保留映射.docx'), chapter1.path, chapter3.path, chapter2.path]); assert.deepEqual(state.value.volumes[1].chapters, []); assert.deepEqual(state.value.volumes[2].chapters, []);
    // Single deletion preserves a missing path's file-independent metadata until explicit removal.
    await edit(path.basename(folderA)); page.once('dialog', d => d.accept()); await modal().getByRole('button', { name: '删除分集 远行卷', exact: true }).click(); await save();
    await edit(path.basename(folderA)); await modal().getByLabel('选择分集 起航卷', { exact: true }).check(); await modal().getByLabel('选择分集 归途卷', { exact: true }).check(); page.once('dialog', d => d.accept()); await modal().getByRole('button', { name: '删除所选分集', exact: true }).click(); assert.deepEqual(await rowIds(), []); await save(); assert.deepEqual((await read(idA)).value.volumes, []);
    for (const [file, bytes] of originals) assert.deepEqual(await fs.readFile(path.join(folderA, file)), bytes); assert.deepEqual(await fs.readFile(path.join(folderA, '小说资料/covers', cover!.asset)), coverBytes);
    // Staged changes are not persisted by closing; external metadata wins a stale save.
    await edit(path.basename(folderA)); await modal().getByRole('button', { name: '＋ 添加分集', exact: true }).click(); await modal().getByLabel('分集名称', { exact: true }).fill('暂存新卷');
    state = await read(idA); await page.evaluate(({ id, state }) => window.writer.saveBook(id, { ...state.value, introduction: '外部更新必须保留' }, state.hash), { id: idA, state });
    await modal().getByRole('button', { name: '保存书架资料', exact: true }).click(); await modal().getByRole('alert').filter({ hasText: '已更新' }).waitFor(); assert.equal((await read(idA)).value.introduction, '外部更新必须保留'); assert.deepEqual((await read(idA)).value.volumes, []); await close(true);
    // Reload fresh baseline and save book details through the common save-and-exit registry.
    await open(folderA); await edit(path.basename(folderA)); await modal().getByRole('button', { name: '＋ 添加分集', exact: true }).click(); await modal().getByLabel('分集名称', { exact: true }).fill('保存退出卷'); await modal().getByLabel(`本集章节 ${chapter1.path}`, { exact: true }).check();
    const png = await app!.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')); await fs.writeFile(path.resolve('.artifacts/volume-management.png'), Buffer.from(png, 'base64'));
    await exitSaved(); await launch(); await open(folderA); state = await read(idA); assert.equal(state.value.volumes[0].title, '保存退出卷'); assert.deepEqual(state.value.volumes[0].chapters, [chapter1.path]);
    // A second book is independent even with the same chapter and volume names.
    const idB = await open(folderB), bChapter = await create(idB, '第01章', 'docx'), bOriginal = await fs.readFile(path.join(folderB, bChapter.path)); await open(folderB); await edit(path.basename(folderB)); await modal().getByRole('button', { name: '＋ 添加分集', exact: true }).click(); await modal().getByLabel('分集名称', { exact: true }).fill('保存退出卷'); await modal().getByLabel(`本集章节 ${bChapter.path}`, { exact: true }).check(); await save(); const bState = await read(idB);
    assert.equal(bState.value.volumes.length, 1); assert.notEqual(bState.value.volumes[0].id, state.value.volumes[0].id); assert.deepEqual((await read(idA)).value, state.value);
    await open(folderA); await edit(path.basename(folderA)); assert.equal(await modal().getByLabel(`选择章节 ${chapter2.path}`, { exact: true }).count(), 1); await close();
    for (const [file, bytes] of originals) assert.deepEqual(await fs.readFile(path.join(folderA, file)), bytes); assert.deepEqual(await fs.readFile(path.join(folderB, bChapter.path)), bOriginal); assert.deepEqual(await fs.readFile(path.join(folderA, '小说资料/covers', cover!.asset)), coverBytes); assert.deepEqual(errors, []);
    console.log('Volume management desktop passed: single/block sorting, cancel/confirm metadata deletion, full-path filtered chapter batching, move/unassign/single toggle, missing mapping retention, conflict, save-exit/restart, two-book isolation and DOCX/TXT/cover original bytes.');
  } catch (e) { if (page!) console.error('Volume UI:', await page.locator('body').innerText().catch(() => 'window closed')); throw e; }
  finally { const remaining = app as ElectronApplication | null; if (remaining) await remaining.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });



