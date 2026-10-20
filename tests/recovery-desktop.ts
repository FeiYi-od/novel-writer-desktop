import { _electron as electron, type ElectronApplication } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import mammoth from 'mammoth';
import { encodeDocx } from '../src/main/docx';
import { textDocument } from '../src/main/text-import';
async function main() {
  const fixture = path.resolve('.artifacts', `recovery-desktop-${Date.now()}`), folder = path.join(fixture, '保存小说甲'), local = path.join(fixture, 'app-data'); await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url); let app: ElectronApplication | null = null;
  const launch = async () => { app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: local } }); const page = await app.firstWindow(); page.setDefaultTimeout(20000); return page; };
  const choose = (file: string) => app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, file);
  try {
    let page = await launch(); await choose(folder); await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click(); await page.getByText('已打开「保存小说甲」· 0 个正文文件（DOCX / TXT）', { exact: true }).waitFor();
    const projectId = (await page.evaluate(() => window.writer.listProjects()))[0].id;
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).click(); await page.getByText('已新建 DOCX · 宋体五号', { exact: true }).waitFor();
    await page.locator('.tiptap').fill('原始正文。'); await page.getByRole('button', { name: '保存 DOCX', exact: true }).click(); await page.getByText('DOCX 已保存到所选文件夹', { exact: true }).waitFor();
    const originalName = (await fs.readdir(folder)).find(n => n.endsWith('.docx'))!;
    await app!.evaluate(({ ipcMain }) => { const handlers = (ipcMain as any)._invokeHandlers; const handler = handlers.get('chapters:save'); ipcMain.removeHandler('chapters:save'); ipcMain.handle('chapters:save', async (event, ...args) => { await new Promise(r => setTimeout(r, 900)); return handler(event, ...args); }); });
    await page.getByLabel('自动保存正文').check(); await page.locator('.tiptap').fill('第一次自动保存内容。'); await page.locator('.tiptap').evaluate(el => el.setAttribute('data-session-test', 'stable'));
    await page.getByText('自动保存中…', { exact: true }).waitFor(); await page.locator('.tiptap').fill('保存期间继续输入的新内容。');
    await page.waitForFunction(async id => { const file = (await window.writer.chapters(id))[0]; const doc = await window.writer.readChapter(id, file.path); return typeof doc.content !== 'string' && JSON.stringify(doc.content).includes('继续输入的新内容'); }, projectId);
    await page.getByText('正文已自动保存', { exact: true }).waitFor(); assert.equal(await page.locator('.tiptap').getAttribute('data-session-test'), 'stable');
    assert.match((await mammoth.extractRawText({ path: path.join(folder, originalName) })).value, /　　保存期间继续输入的新内容。/);
    const beforeCrash = await fs.readFile(path.join(folder, originalName));
    await page.getByLabel('自动保存正文').uncheck(); await page.locator('.tiptap').fill('异常退出前尚未写入原稿的内容。'); await page.getByText('正文有未保存修改 · 本机草稿已暂存', { exact: true }).waitFor();
    const pending = (await page.evaluate(id => window.writer.recoveryDrafts(id), projectId)).filter(e => e.status === 'pending'); assert.equal(pending.length, 1);
    // Exit immediately without the normal unsaved-changes flow; only an already
    // committed checkpoint survives this simulated abnormal shutdown.
    await app!.evaluate(({ app: instance }) => instance.exit(0)); app = null;
    page = await launch(); await choose(folder); await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click(); await page.getByRole('button', { name: '恢复本书草稿', exact: true }).click();
    await page.getByRole('button').filter({ hasText: '未确认写入原文件' }).click(); await page.getByLabel('恢复草稿预览').waitFor(); assert.match(await page.getByLabel('恢复草稿预览').textContent() ?? '', /　　异常退出前/);
    await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const png = await app!.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')); await fs.writeFile(path.resolve('.artifacts/recovery.png'), Buffer.from(png, 'base64'));
    await page.getByRole('button', { name: '恢复为新 DOCX', exact: true }).click(); await page.getByText('已恢复为新 DOCX，原文件保留', { exact: true }).waitFor();
    assert.match(await page.locator('.tiptap').textContent() ?? '', /异常退出前/); assert.deepEqual(await fs.readFile(path.join(folder, originalName)), beforeCrash); assert.equal((await fs.readdir(folder)).filter(n => n.endsWith('.docx')).length, 2);
    const other = path.join(fixture, '保存小说乙'); await fs.mkdir(other); await choose(other); await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click(); await page.getByRole('button', { name: '恢复本书草稿', exact: true }).click(); await page.getByText('尚无可恢复的本机正文暂存。编辑后约 2 秒生成暂存，不包括旧版无来源信息的备份。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '写作空间', exact: true }).click(); await page.getByLabel('新章节格式').selectOption('txt'); await page.getByRole('button', { name: '＋ 新建 TXT 章节' }).click(); await page.getByText('已新建 TXT · 宋体五号', { exact: true }).waitFor();
    await page.getByLabel('自动保存正文').check(); await page.locator('.tiptap').fill('TXT 自动保存测试。'); await page.getByText('正文已自动保存', { exact: true }).waitFor();
    const txt = (await fs.readdir(other)).find(n => n.endsWith('.txt'))!; assert.equal(await fs.readFile(path.join(other, txt), 'utf8'), '　　TXT 自动保存测试。');
    await page.locator('.tiptap').fill('不应覆盖外部文本。'); await fs.writeFile(path.join(other, txt), '外部修改必须保留。', 'utf8'); await page.getByRole('alert').filter({ hasText: '自动保存已停止' }).waitFor(); assert.equal(await fs.readFile(path.join(other, txt), 'utf8'), '外部修改必须保留。');
    const bId = (await page.evaluate(() => window.writer.listProjects())).find(p => p.root.endsWith('保存小说乙'))!.id; const latest = (await page.evaluate(id => window.writer.recoveryDrafts(id), bId)).find(e => e.status === 'pending')!; assert.ok(latest); assert.match(JSON.stringify((await page.evaluate(({ id, entryId }) => window.writer.readRecoveryDraft(id, entryId), { id: bId, entryId: latest.id })).content), /不应覆盖/);
    console.log('Recovery desktop passed: autosave DOCX/TXT, typing during delayed save, stable editor, committed checkpoint after abnormal exit, new DOCX restore, cross-book isolation and external conflict stop.');
  } finally { const remaining = app as ElectronApplication | null; if (remaining) await remaining.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
