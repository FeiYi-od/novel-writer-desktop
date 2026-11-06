import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  const root = await fs.mkdtemp(path.resolve('.artifacts/shelf-polish-'));
  const folder = path.join(root, '虚构星港'); await fs.mkdir(folder);
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(root, 'data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  try {
    await app.evaluate(({ dialog, BrowserWindow }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); BrowserWindow.getAllWindows()[0].setSize(1000, 720); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByText('已打开「虚构星港」', { exact: false }).waitFor();
    await page.getByRole('button', { name: '我的书架', exact: true }).click();
    await page.getByRole('button', { name: '编辑作品 虚构星港' }).click();
    const title = 'StarHarbor' + '很长的虚构作品名称'.repeat(10);
    await page.getByLabel('小说名称', { exact: true }).fill(title);
    await page.getByLabel('小说引言', { exact: true }).fill('这是一段用于检查界面布局的虚构故事引言。');
    await page.getByRole('button', { name: '保存书架资料', exact: true }).click();
    await page.getByRole('heading', { name: title, exact: true }).waitFor();
    await page.getByLabel('搜索书架').fill('starharbor');
    assert.equal(await page.locator('.shelf-card').count(), 1);
    const layout = await page.locator('.shelf-card').evaluate(el => ({ width: el.scrollWidth, client: el.clientWidth, title: el.querySelector('h2')!.scrollWidth, titleClient: el.querySelector('h2')!.clientWidth }));
    assert.ok(layout.width <= layout.client + 1, '长标题不得撑出卡片');
    assert.ok(layout.title <= layout.titleClient + 1, '长标题应换行');
    const cover = page.getByRole('button', { name: `打开作品 ${title}` });
    await page.getByLabel('搜索书架').focus(); await page.keyboard.press('Tab');
    assert.equal(await page.getByTestId('new-book-open').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await cover.evaluate(el => el === document.activeElement), true);
    assert.notEqual(await cover.evaluate(el => getComputedStyle(el).outlineStyle), 'none');
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    await fs.writeFile(path.join(root, 'shelf-narrow.png'), Buffer.from(png, 'base64'));
    await page.getByLabel('搜索书架').fill('不存在的作品');
    await page.getByRole('button', { name: '清除搜索' }).click();
    assert.equal(await page.getByLabel('搜索书架').inputValue(), '');
    assert.equal(await page.locator('.shelf-card').count(), 1);
    console.log(`Shelf polish desktop passed: ${root}`);
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
