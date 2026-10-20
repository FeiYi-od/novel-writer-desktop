import { _electron as electron, type ElectronApplication } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { Workspace } from '../src/main/workspace';
import { StoryMemoryStore } from '../src/main/story-memory';
import { encodeDocx } from '../src/main/docx';
import { textDocument } from '../src/main/text-import';

async function main() {
  const fixture = path.resolve('.artifacts', `rename-desktop-${Date.now()}`), folderA = path.join(fixture, '命名小说甲'), folderB = path.join(fixture, '命名小说乙'), local = path.join(fixture, 'app-data');
  await fs.mkdir(folderA, { recursive: true }); await fs.mkdir(folderB); const require = createRequire(import.meta.url); let app: ElectronApplication | null = null;
  const launch = async () => { app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: local } }); const page = await app.firstWindow(); page.setDefaultTimeout(15000); return page; };
  try {
    let page = await launch();
    const open = async (folder: string) => { await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder); await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click(); await page.getByText(`已打开「${path.basename(folder)}」`, { exact: false }).waitFor(); return (await page.evaluate(() => window.writer.listProjects())).find(p => p.root === folder)!.id; };
    const idA = await open(folderA); await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).click(); await page.locator('.tiptap').fill('林夏在雨中遇见同伴。');
    assert.equal(await page.getByRole('button', { name: '重命名', exact: true }).isDisabled(), true); await page.getByRole('button', { name: '保存 DOCX', exact: true }).click(); await page.getByText('DOCX 已保存到所选文件夹', { exact: true }).waitFor();
    const old = (await fs.readdir(folderA)).find(n => n.endsWith('.docx'))!; const original = await page.evaluate(({ id, p }) => window.writer.readChapter(id, p), { id: idA, p: old }), bytes = await fs.readFile(path.join(folderA, old));
    const book = await page.evaluate(id => window.writer.readBook(id), idA); const volumeId = randomUUID(); await page.evaluate(({ id, snapshot, volumeId, old }) => window.writer.saveBook(id, { ...snapshot.value, volumes: [{ id: volumeId, title: '雨的序幕', introduction: '', cover: '', chapters: [old] }] }, snapshot.hash), { id: idA, snapshot: book, volumeId, old });
    // An author-confirmed synthetic fixture, written only into this test's MD.
    const hostWorkspace = new Workspace(local, path.join(local, '创作资料')); await hostWorkspace.initialize(); const memories = new StoryMemoryStore(hostWorkspace, path.join(local, '创作资料')); const mem = await memories.read(idA); await memories.add(idA, { id: randomUUID(), projectId: idA, sourcePath: old, sourceHash: original.hash, content: '林夏遇见同伴。', taskId: randomUUID(), model: '人工测试资料', createdAt: new Date().toISOString(), enabled: true, important: true }, mem.hash);
    await open(folderA); await page.getByLabel('查看分集').selectOption(volumeId); await page.getByRole('button', { name: old, exact: false }).click();
    await page.getByRole('button', { name: '重命名', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '章节重命名' }); await dialog.waitFor();
    await page.getByLabel('新的章节名称').fill('../错误名称'); await dialog.getByRole('button', { name: '确认重命名' }).click(); await dialog.getByRole('alert').waitFor(); assert.deepEqual(await fs.readFile(path.join(folderA, old)), bytes);
    await page.getByLabel('新的章节名称').fill('第一章·雨中初遇'); await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const png = await app!.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')); await fs.writeFile(path.resolve('.artifacts/chapter-rename.png'), Buffer.from(png, 'base64'));
    await dialog.getByRole('button', { name: '确认重命名' }).click(); await page.getByText('章节已重命名，原稿归档保留', { exact: true }).waitFor(); const renamed = '第一章·雨中初遇.docx';
    assert.equal(await page.getByLabel('查看分集').inputValue(), volumeId); await page.getByRole('button', { name: renamed, exact: false }).waitFor(); assert.equal(await page.locator('.chapter-list button').count(), 1); assert.deepEqual(await fs.readFile(path.join(folderA, renamed)), bytes); await assert.rejects(fs.stat(path.join(folderA, old)), /ENOENT/);
    const after = await page.evaluate(id => window.writer.readBook(id), idA); assert.equal(after.value.volumes[0].chapters[0], renamed); assert.equal((await page.evaluate(({ id, p }) => window.writer.readChapter(id, p), { id: idA, p: old })).path, renamed);
    const recordFolder = path.join(folderA, '小说资料/chapter-renames', (await fs.readdir(path.join(folderA, '小说资料/chapter-renames'))).find(n => /^[a-f0-9-]{36}$/.test(n))!); assert.deepEqual(await fs.readFile(path.join(recordFolder, 'original.docx')), bytes);
    await page.getByRole('button', { name: '记忆', exact: true }).click(); await page.getByRole('button', { name: '打开章节摘要与故事记忆' }).click(); await page.locator('.review-issue strong').filter({ hasText: renamed }).waitFor(); await page.getByText('来源版本有效', { exact: false }).waitFor();
    await app!.evaluate(({ app: instance }) => instance.exit(0)); app = null; page = await launch(); await open(folderA); await page.getByRole('button', { name: renamed, exact: false }).click(); assert.match(await page.locator('.tiptap').textContent() ?? '', /林夏在雨中/); assert.equal(await page.locator('.tiptap').getAttribute('contenteditable'), 'true');
    const external = '外部原稿.docx', externalBytes = await encodeDocx(textDocument('外部Word原稿只改名称。')); await fs.writeFile(path.join(folderA, external), externalBytes); await page.getByTitle('重新扫描文件夹').click(); await page.getByRole('button', { name: external, exact: false }).click(); assert.equal(await page.locator('.tiptap').getAttribute('contenteditable'), 'false');
    await page.getByRole('button', { name: '重命名', exact: true }).click(); await page.getByLabel('新的章节名称').fill('外部原稿新名'); await page.getByRole('button', { name: '确认重命名', exact: true }).click(); await page.getByText('章节已重命名，原稿归档保留', { exact: true }).waitFor(); assert.deepEqual(await fs.readFile(path.join(folderA, '外部原稿新名.docx')), externalBytes); assert.equal(await page.locator('.tiptap').getAttribute('contenteditable'), 'false');
    const idB = await open(folderB); await page.getByLabel('新章节格式').selectOption('txt'); await page.getByRole('button', { name: '＋ 新建 TXT 章节' }).click(); await page.locator('.tiptap').fill('另一部小说的同名林夏。'); await page.getByRole('button', { name: '保存 TXT', exact: true }).click(); await page.getByText('TXT 已保存到所选文件夹', { exact: true }).waitFor();
    await page.getByRole('button', { name: '重命名', exact: true }).click(); await page.getByLabel('新的章节名称').fill('海上的第一章'); await page.getByRole('button', { name: '确认重命名', exact: true }).click(); await page.getByText('章节已重命名，原稿归档保留', { exact: true }).waitFor(); assert.equal(await fs.readFile(path.join(folderB, '海上的第一章.txt'), 'utf8'), '　　另一部小说的同名林夏。');
    assert.equal((await page.evaluate(id => window.writer.readMemories(id), idB)).value.entries.length, 0); assert.deepEqual(await fs.readFile(path.join(folderA, renamed)), bytes);
    await page.getByRole('button', { name: '重命名', exact: true }).click(); await page.getByLabel('新的章节名称').fill('冲突名称'); await fs.writeFile(path.join(folderB, '海上的第一章.txt'), '外部修改，必须保留。'); await page.getByRole('button', { name: '确认重命名', exact: true }).click(); await page.getByRole('dialog').getByRole('alert').filter({ hasText: '其他程序修改' }).waitFor(); assert.equal(await fs.readFile(path.join(folderB, '海上的第一章.txt'), 'utf8'), '外部修改，必须保留。'); await assert.rejects(fs.stat(path.join(folderB, '冲突名称.txt')), /ENOENT/);
    console.log('Rename desktop passed: invalid name/no overwrite, raw DOCX/TXT bytes and archive, volume/summary references, restart, readonly Word protection, cross-book isolation and external conflict.');
  } finally { const remaining = app as ElectronApplication | null; if (remaining) await remaining.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
