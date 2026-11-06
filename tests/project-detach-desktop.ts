import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--exe' && path.isAbsolute(args[1]!)), 'Usage: tsx tests/project-detach-desktop.ts [--exe <absolute packaged exe>]');
const executable = args.length ? path.resolve(args[1]!) : createRequire(import.meta.url)('electron') as string;

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/project-detach-ui-'));
  const folders = [path.join(fixture, '虚构星书甲'), path.join(fixture, '虚构星书乙')];
  await Promise.all(folders.map(folder => fs.mkdir(folder)));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((item): item is [string,string] => typeof item[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'app-data'); delete env.ELECTRON_RUN_AS_NODE;
  let app!: ElectronApplication, page!: Page, accept = true, confirmations = 0;
  let projectAId = '', originalA!: Buffer, notesA!: Buffer, noteFileA = '';
  const launch = async () => {
    app = await electron.launch({ executablePath: executable, args: args.length ? [] : [path.resolve('out/main/index.js')], env });
    if (args.length) {
      const expected = JSON.parse(await fs.readFile('package.json', 'utf8')).version as string;
      const actual = await app.evaluate(({ app: instance }) => ({ packaged: instance.isPackaged, version: instance.getVersion(), path: instance.getAppPath() }));
      assert.equal(actual.packaged, true); assert.equal(actual.version, expected);
      assert.equal(await fs.realpath(actual.path), await fs.realpath(path.join(path.dirname(executable), 'resources/app.asar')));
    }
    page = await app.firstWindow(); page.setDefaultTimeout(20000);
    page.on('dialog', dialog => { confirmations++; void (accept ? dialog.accept() : dialog.dismiss()); });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 720));
    await page.getByRole('heading', { name: '我的书架', exact: false }).waitFor();
  };
  const openFolder = async (folder: string) => {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByText(`已打开「${path.basename(folder)}」`, { exact: false }).waitFor();
  };
  const shelf = async () => { await page.getByRole('button', { name: '我的书架', exact: true }).click(); await page.getByRole('heading', { name: '我的书架', exact: false }).waitFor(); };
  const writer = async () => { await page.getByRole('button', { name: '写作空间', exact: true }).click(); await page.locator('.tiptap').waitFor(); };
  const saveFiction = async (text: string, note: string) => {
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节', exact: true }).click();
    await page.locator('.tiptap').fill(text); await page.getByRole('button', { name: '保存 DOCX', exact: true }).click();
    await page.getByText('DOCX 已保存到所选文件夹', { exact: true }).waitFor();
    await page.getByLabel('人物笔记').fill(note); await page.getByRole('button', { name: '保存本书资料', exact: true }).click();
    await page.getByText('本书资料已保存', { exact: true }).waitFor();
  };
  const removeButton = (name: string) => page.getByRole('button', { name: `从书架移除 ${name}`, exact: true });
  await launch();
  try {
    await openFolder(folders[0]); await saveFiction('甲书虚构正文。', '甲书虚构人物设定。');
    const projectA = (await page.evaluate(() => window.writer.listProjects())).find(p => p.name === '虚构星书甲')!;
    projectAId = projectA.id;
    const chapterA = (await fs.readdir(folders[0])).find(item => item.endsWith('.docx'))!;
    originalA = await fs.readFile(path.join(folders[0], chapterA));
    const materialA = await page.evaluate(id => window.writer.materialLocation(id), projectA.id);
    noteFileA = path.join(materialA, '创作笔记.md'); notesA = await fs.readFile(noteFileA);
    await openFolder(folders[1]); await saveFiction('乙书虚构正文。', '乙书虚构人物设定。');
    const projectB = (await page.evaluate(() => window.writer.listProjects())).find(p => p.name === '虚构星书乙')!;
    const chapterB = (await fs.readdir(folders[1])).find(item => item.endsWith('.docx'))!;
    const originalB = await fs.readFile(path.join(folders[1], chapterB));
    const materialB = await page.evaluate(id => window.writer.materialLocation(id), projectB.id);
    const noteFileB = path.join(materialB, '创作笔记.md'); const notesB = await fs.readFile(noteFileB);

    await page.locator('.tiptap').fill('乙书尚未保存的正文。'); await shelf();
    const beforeDirty = confirmations; await removeButton('虚构星书甲').click();
    await page.getByRole('alert').filter({ hasText: '请先保存正文和各页资料' }).waitFor();
    assert.equal(confirmations, beforeDirty, '脏正文应在确认框前拒绝'); await writer();
    assert.match(await page.locator('.tiptap').innerText(), /乙书尚未保存的正文/u);
    await page.getByRole('button', { name: '保存 DOCX', exact: true }).click();
    await page.getByText('DOCX 已保存到所选文件夹', { exact: true }).waitFor();
    const savedB = await fs.readFile(path.join(folders[1], chapterB));
    await page.getByText('更多功能', { exact: true }).click(); await page.getByRole('button', { name: '创作筹备', exact: true }).click();
    await page.getByLabel('筹备构想').fill('乙书待保存筹备构想。'); await shelf();
    const beforePlanning = confirmations; await removeButton('虚构星书甲').click();
    await page.getByRole('alert').filter({ hasText: '请先保存正文和各页资料' }).waitFor();
    assert.equal(confirmations, beforePlanning, '隐藏筹备修改应在确认框前拒绝');
    await page.getByText('更多功能', { exact: true }).click(); await page.getByRole('button', { name: '创作筹备', exact: true }).click();
    assert.equal(await page.getByLabel('筹备构想').inputValue(), '乙书待保存筹备构想。');
    await page.getByRole('button', { name: '保存筹备资料', exact: true }).click(); await page.getByText('筹备提示词与草稿已保存').waitFor(); await shelf();

    const card = removeButton('虚构星书甲').locator('xpath=ancestor::article');
    await card.scrollIntoViewIfNeeded();
    const bounds = await card.evaluate(el => { const r=el.getBoundingClientRect(); return [...el.querySelectorAll('.card-actions button')].map(button => { const b=button.getBoundingClientRect(); return b.left>=r.left && b.right<=r.right && b.bottom<=r.bottom; }); });
    assert.equal(bounds.length, 4); assert.ok(bounds.every(Boolean), '1000px 时四个操作不得越界');
    await page.screenshot({ path: path.join(fixture, 'shelf-detach.png') });
    accept = false; const beforeCancel = confirmations; const cancelled = page.waitForEvent('dialog'); await removeButton('虚构星书甲').click(); await cancelled;
    assert.equal(confirmations, beforeCancel + 1); assert.equal(await removeButton('虚构星书甲').count(), 1);
    accept = true; await removeButton('虚构星书甲').click();
    await removeButton('虚构星书甲').waitFor({ state: 'detached' });
    await page.getByTestId('shelf-removal-notice').filter({ hasText: '原文件与创作资料已保留' }).waitFor();
    await writer(); assert.match(await page.locator('.tiptap').innerText(), /乙书尚未保存的正文/u);
    assert.equal((await page.evaluate(() => window.writer.listProjects())).some(p => p.id === projectA.id), false);
    await shelf(); await removeButton('虚构星书乙').click(); await removeButton('虚构星书乙').waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('button', { name: '写作空间', exact: true }).isDisabled(), true, '移除当前书后清除当前会话');
    assert.deepEqual(await fs.readFile(path.join(folders[0], chapterA)), originalA); assert.deepEqual(await fs.readFile(noteFileA), notesA);
    assert.deepEqual(await fs.readFile(path.join(folders[1], chapterB)), savedB); assert.notDeepEqual(savedB, originalB); assert.deepEqual(await fs.readFile(noteFileB), notesB);
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
  await launch();
  try {
    assert.equal((await page.evaluate(() => window.writer.listProjects())).length, 0, '重启后不会复现已移除的书');
    await openFolder(folders[0]); const reopened = (await page.evaluate(() => window.writer.listProjects())).find(p => p.name === '虚构星书甲')!;
    assert.equal(reopened.id, projectAId, '重新加入应恢复原小说 ID');
    assert.deepEqual(await fs.readFile(path.join(folders[0], (await fs.readdir(folders[0])).find(item => item.endsWith('.docx'))!)), originalA);
    assert.deepEqual(await fs.readFile(noteFileA), notesA);
    console.log(`Project detach desktop passed: ${fixture}`);
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
