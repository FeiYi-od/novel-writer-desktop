import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import mammoth from 'mammoth';
import type { RichNode } from '../src/shared/contracts';
import { encodeDocx } from '../src/main/docx';
import { textDocument } from '../src/main/text-import';

async function main() {
  const fixture = path.resolve('.artifacts', `search-desktop-${Date.now()}`);
  const folderA = path.join(fixture, '查找小说甲'), folderB = path.join(fixture, '查找小说乙');
  await fs.mkdir(folderA, { recursive: true }); await fs.mkdir(folderB);
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const open = async (folder: string) => {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click(); await page.getByText(`已打开「${path.basename(folder)}」`, { exact: false }).waitFor();
    return (await page.evaluate(() => window.writer.listProjects())).find(p => p.root === folder)!.id;
  };
  const refresh = async () => page.getByTitle('重新扫描文件夹').click();
  const body = page.locator('.tiptap'); const finder = page.getByRole('search', { name: '本章查找替换' });
  const query = page.getByLabel('查找文字', { exact: true }), replacement = page.getByLabel('替换文字', { exact: true });
  try {
    const idA = await open(folderA);
    const rich: RichNode = { type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '林夏的章节' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '　　' }, { type: 'text', text: '林', marks: [{ type: 'bold' }] }, { type: 'text', text: '夏在窗边，林夏点头。 ABC abc 😀 [a+b]。' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '　　林' }, { type: 'hardBreak' }, { type: 'text', text: '夏' }] }
    ] };
    const manuscript = await page.evaluate(({ id, content }) => window.writer.copyChapter(id, content), { id: idA, content: rich });
    await refresh(); await page.getByRole('button', { name: path.basename(manuscript.path), exact: false }).click(); await body.waitFor();
    const bytesBefore = await fs.readFile(path.join(folderA, manuscript.path));
    assert.equal(await page.getByRole('button', { name: '保存 DOCX', exact: true }).isDisabled(), true);
    await body.press('Control+f'); await finder.waitFor(); await query.fill('林夏');
    await finder.getByText('1 / 3', { exact: true }).waitFor(); assert.equal((await body.locator('.search-hit').allTextContents()).join(''), '林夏'.repeat(3), '跨样式匹配可拆成多个装饰DOM，按实际高亮文字验证');
    assert.equal(await page.getByRole('button', { name: '保存 DOCX', exact: true }).isDisabled(), true, '查询/装饰不应修改正文');
    await finder.getByRole('button', { name: '下一处', exact: true }).click(); await finder.getByText('2 / 3', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), '林夏');
    // Simulate a composing shortcut, without claiming a real hardware IME test.
    await query.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }))); assert.equal(await finder.isVisible(), true);
    await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')); await fs.writeFile(path.resolve('.artifacts/search.png'), Buffer.from(png, 'base64'));
    await replacement.fill('小雨'); await finder.getByRole('button', { name: '全部替换', exact: true }).click(); await finder.getByText('已替换 3 处，可撤销', { exact: true }).waitFor();
    assert.equal(await body.locator('h2').textContent(), '小雨的章节'); assert.equal((await body.locator('strong').textContent())?.replace(/^[\u3000]+/, ''), '小雨');
    assert.match(await body.locator('p').first().textContent() ?? '', /^　　小雨/); assert.deepEqual(await fs.readFile(path.join(folderA, manuscript.path)), bytesBefore);
    await page.getByRole('button', { name: '撤销', exact: true }).click(); await finder.getByText('1 / 3', { exact: true }).waitFor(); assert.equal(await body.locator('h2').textContent(), '林夏的章节');
    await page.getByRole('button', { name: '重做', exact: true }).click(); assert.equal(await body.locator('h2').textContent(), '小雨的章节');
    await page.getByRole('button', { name: '保存 DOCX', exact: true }).click(); await page.getByText('DOCX 已保存到所选文件夹', { exact: true }).waitFor();
    const saved = await page.evaluate(({ id, name }) => window.writer.readChapter(id, name), { id: idA, name: manuscript.path }); assert.equal(typeof saved.content, 'object');
    if (typeof saved.content !== 'string') { assert.equal(saved.content.content![0].type, 'heading'); assert.ok(saved.content.content![1].content!.some(run => run.text?.replace(/^[\u3000]+/, '') === '小雨' && run.marks?.some(mark => mark.type === 'bold'))); }
    assert.match((await mammoth.extractRawText({ path: path.join(folderA, manuscript.path) })).value, /　　小雨在窗边/);
    await body.press('Control+h'); await query.fill('ABC'); await finder.getByText('1 / 2', { exact: true }).waitFor(); await page.getByLabel('区分大小写').check(); await finder.getByText('1 / 1', { exact: true }).waitFor();
    await query.fill('[a+b]'); await finder.getByText('1 / 1', { exact: true }).waitFor(); await query.fill('　　'); await finder.getByText('未找到', { exact: true }).waitFor();
    await page.getByLabel('关闭查找').click();
    // Shortcut in another page cannot open the hidden manuscript's panel.
    await page.getByRole('button', { name: '模型设置', exact: true }).click(); await page.keyboard.press('Control+f'); assert.equal(await page.locator('.chapter-search').count(), 0); await page.getByRole('button', { name: '写作空间', exact: true }).click();
    const externalName = '外部文档.docx', externalBytes = await encodeDocx(textDocument('林夏的外部原稿。')); await fs.writeFile(path.join(folderA, externalName), externalBytes); await refresh();
    await page.getByRole('button', { name: externalName, exact: false }).click(); await page.getByRole('button', { name: '查找替换', exact: true }).click(); await query.fill('林夏'); await finder.getByText('1 / 1', { exact: true }).waitFor();
    assert.equal(await finder.getByRole('button', { name: '全部替换', exact: true }).isDisabled(), true); assert.equal(await finder.getByRole('button', { name: '替换当前', exact: true }).isDisabled(), true); assert.deepEqual(await fs.readFile(path.join(folderA, externalName)), externalBytes);
    const idB = await open(folderB); await page.getByLabel('新章节格式').selectOption('txt'); await page.getByRole('button', { name: '＋ 新建 TXT 章节' }).click(); await body.fill('林夏 ABC abc。'); await page.getByRole('button', { name: '保存 TXT', exact: true }).click(); await page.getByText('TXT 已保存到所选文件夹', { exact: true }).waitFor();
    await body.press('Control+f'); assert.equal(await query.inputValue(), ''); assert.equal(await replacement.inputValue(), ''); await query.fill('林夏'); await finder.getByText('1 / 1', { exact: true }).waitFor();
    await query.fill('ABC'); await page.getByLabel('区分大小写').check(); await replacement.fill('<b>字</b> 😀'); await page.getByLabel('自动保存正文').check(); await finder.getByRole('button', { name: '替换当前', exact: true }).click(); await page.getByText('正文已自动保存', { exact: true }).waitFor();
    assert.equal(await finder.isVisible(), true); assert.equal(await query.inputValue(), 'ABC'); assert.equal(await body.locator('b').count(), 0);
    const txtName = (await fs.readdir(folderB)).find(n => n.endsWith('.txt'))!; assert.equal(await fs.readFile(path.join(folderB, txtName), 'utf8'), '　　林夏 <b>字</b> 😀 abc。');
    await page.getByLabel('自动保存正文').uncheck(); await query.fill('abc'); await replacement.fill('替换后的草稿'); await finder.getByRole('button', { name: '替换当前', exact: true }).click();
    await fs.writeFile(path.join(folderB, txtName), '外部原稿必须保留。'); await page.getByRole('button', { name: '保存 TXT', exact: true }).click(); await page.getByRole('alert').filter({ hasText: '其他程序修改' }).waitFor();
    assert.equal(await fs.readFile(path.join(folderB, txtName), 'utf8'), '外部原稿必须保留。'); assert.match(await body.textContent() ?? '', /替换后的草稿/);
    assert.ok((await page.evaluate(id => window.writer.recoveryDrafts(id), idB)).some(e => e.status === 'pending'));
    assert.deepEqual(await fs.readFile(path.join(folderA, externalName)), externalBytes); assert.match((await mammoth.extractRawText({ path: path.join(folderA, manuscript.path) })).value, /小雨/); assert.equal(errors.length, 0);
    console.log('Search desktop passed: literal highlights/navigation, composing shortcut guard, one-step undo/redo, rich DOCX styles/prefix, readonly safety, hidden-view and cross-book isolation, TXT autosave, literal replacement, external conflict and draft retention.');
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
