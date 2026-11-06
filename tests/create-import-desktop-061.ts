import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { encodeDocx } from '../src/main/docx';
import { textDocument } from '../src/main/text-import';

// R4：应用内新建小说 + 导入章节（虚构数据、临时目录）
async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/create-import-desktop-'));
  const parent = path.join(fixture, '作者的书'); await fs.mkdir(parent, { recursive: true });
  const sources = path.join(fixture, '来源'); await fs.mkdir(sources, { recursive: true });
  const docx = new Uint8Array(await encodeDocx(textDocument('　　导入的第一章正文。')));
  const docxFile = path.join(sources, '第一章.docx'); await fs.writeFile(docxFile, docx);
  const txtFile = path.join(sources, '旧稿.txt'); await fs.writeFile(txtFile, Buffer.from('　　导入的 TXT 正文。\n', 'utf8'));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(25000);
    await page.getByTestId('new-book-open').click();
    await page.getByTestId('new-book-title').fill('海上城邦');
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, parent);
    await page.getByTestId('new-book-pick').click();
    await page.getByTestId('new-book-preview').filter({ hasText: '海上城邦' }).waitFor();
    // 封面 + 引言：走真实选图与初始化写盘
    const coverPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const coverPath = path.join(sources, '封面.png'); await fs.writeFile(coverPath, coverPng);
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, coverPath);
    await page.getByTestId('new-book-cover').click();
    try { await page.getByTestId('new-book-cover-preview').waitFor({ timeout: 15000 }); } catch (failure) { console.error('COVER_DEBUG', await page.locator('.error').allTextContents()); throw failure; }
    await page.getByTestId('new-book-introduction').fill('一句话：海上的城邦与风。');
    await page.getByTestId('new-book-create').click();
    const bookRoot = path.join(parent, '海上城邦');
    await page.waitForFunction(async root => {
      try { return (await window.writer.listProjects()).some(item => item.root === root); } catch { return false; }
    }, await fs.realpath(parent).then(real => path.join(real, '海上城邦')), { timeout: 20000 });
    assert.ok((await fs.stat(path.join(bookRoot, '小说资料', 'project.json'))).isFile(), '新书应写入 project.json');
    // 引言与封面在创建后异步写入，轮询到落盘再断言（避免竞态误判）
    await page.waitForFunction(async () => {
      const project = (await window.writer.listProjects()).find(item => item.name === '海上城邦');
      if (!project) return false;
      const book = await window.writer.readBook(project.id);
      return book?.value.introduction === '一句话：海上的城邦与风。' && !!book.value.cover && book.covers[book.value.cover]?.startsWith('data:image/png');
    }, undefined, { timeout: 20000 });
    await page.getByText(/已新建 DOCX/u).waitFor({ timeout: 15000 }).catch(() => undefined);
    const chaptersAfterCreate = await page.evaluate(async () => {
      const project = (await window.writer.listProjects()).find(item => item.name === '海上城邦');
      return project ? window.writer.chapters(project.id) : [];
    });
    assert.equal(chaptersAfterCreate.length, 1, '应自动创建首章');

    // 预置同名文件：导入必须另起名字，不能覆盖
    await fs.writeFile(path.join(bookRoot, '旧稿.txt'), '原始内容必须保留', 'utf8');
    await page.getByTestId('import-chapters').waitFor();
    page.on('dialog', dialog => void dialog.accept());
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [docxFile, txtFile]);
    await page.getByTestId('import-chapters').click();
    await page.getByTestId('import-preview').waitFor({ timeout: 20000 });
    await page.getByLabel('目标名 1', { exact: true }).fill('开篇.docx');
    await page.getByTestId('import-confirm').click();
    await page.getByText(/已导入 2 个章节副本/u).waitFor({ timeout: 20000 });
    assert.deepEqual(new Uint8Array(await fs.readFile(path.join(bookRoot, '开篇.docx'))), docx, 'DOCX 必须逐字节导入');
    assert.equal(await fs.stat(path.join(bookRoot, '第一章.docx')).then(() => true).catch(() => false), false, '改名后不应留下原名文件');
    assert.equal(await fs.readFile(path.join(bookRoot, '旧稿.txt'), 'utf8'), '原始内容必须保留');
    assert.equal(await fs.readFile(path.join(bookRoot, '旧稿-导入-1.txt'), 'utf8'), '　　导入的 TXT 正文。\n');
    const paths = (await page.evaluate(async () => {
      const project = (await window.writer.listProjects()).find(item => item.name === '海上城邦');
      return project ? (await window.writer.chapters(project.id)).map(item => item.path) : [];
    })).sort();
    assert.ok(paths.includes('开篇.docx'));
    assert.equal(paths.some(item => item === '第一章.docx'), false);
    assert.ok(paths.includes('旧稿-导入-1.txt'));
    // 整本 TXT 拆章：标题行分段 + 预览校正
    const wholeText = '　　开场白。\n\n第一章 起风\n　　风从北面来。\n\n第二章 落雨\n　　雨落在屋檐上。\n';
    const wholeFile = path.join(sources, '旧稿合集.txt'); await fs.writeFile(wholeFile, wholeText, 'utf8');
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, wholeFile);
    await page.getByTestId('import-split').click();
    await page.getByTestId('import-preview').waitFor({ timeout: 20000 });
    await page.getByTestId('import-confirm').click();
    await page.getByText(/已导入 3 个章节副本/u).waitFor({ timeout: 20000 });
    assert.equal(await fs.readFile(path.join(bookRoot, '第一章 起风.txt'), 'utf8'), '第一章 起风\n　　风从北面来。\n');
    assert.equal(await fs.readFile(path.join(bookRoot, '序前.txt'), 'utf8'), '　　开场白。\n');
    // 章节删除到回收站再恢复（R3）：先打开一个章节，删除按钮才可用
    await page.locator('.chapter-list button').filter({ hasText: '开篇.docx' }).first().click();
    await page.getByTestId('delete-chapter').waitFor();
    await page.getByTestId('delete-chapter').click();
    await page.getByText(/已移到回收站：/u).waitFor({ timeout: 20000 });
    await page.getByTestId('open-trash').click();
    await page.getByTestId('trash-panel').waitFor({ timeout: 20000 });
    assert.equal((await fs.readdir(bookRoot)).some(name => name === '开篇.docx'), false, '被删章节应已移出原位');
    await page.locator('[data-testid^="trash-restore-"]').first().click();
    await page.getByText(/已恢复：/u).waitFor({ timeout: 20000 });
    assert.equal((await fs.readdir(bookRoot)).some(name => name === '开篇.docx'), true, '恢复后章节文件应回到原位');
    await page.getByRole('dialog', { name: '章节回收站' }).getByRole('button', { name: '关闭' }).click();
    console.log('Create/import desktop passed: 新建小说含首章，导入 DOCX/TXT 不覆盖同名原稿，整本 TXT 拆章，章节删除可恢复。');
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
