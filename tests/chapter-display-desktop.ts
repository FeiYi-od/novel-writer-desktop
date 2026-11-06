import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/chapter-display-desktop-'));
  const folderA = path.join(fixture, '虚构章节甲'), folderB = path.join(fixture, '虚构章节乙'); await fs.mkdir(folderA); await fs.mkdir(folderB);
  const file = '第一章.txt', textA = '虚构甲正文。', textB = '虚构乙正文。'; await fs.writeFile(path.join(folderA, file), textA); await fs.writeFile(path.join(folderB, file), textB);
  const args = process.argv.slice(2); assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--exe' && path.isAbsolute(args[1]!)));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null; let page!: Page;
  async function launch() {
    app = await electron.launch({ executablePath: args.length ? args[1]! : createRequire(import.meta.url)('electron'), args: args.length ? [] : [path.resolve('out/main/index.js')], env });
    if (args.length) { const info = await app.evaluate(({app}) => ({ packaged: app.isPackaged, version: app.getVersion() })); assert.equal(info.packaged, true); assert.equal(info.version, JSON.parse(await fs.readFile('package.json', 'utf8')).version); }
    page = await app.firstWindow(); page.setDefaultTimeout(30000); await page.setViewportSize({ width: 1000, height: 720 }); page.on('dialog', dialog => void dialog.accept());
  }
  async function open(folder: string) {
    await app!.evaluate(({dialog}, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click(); await page.getByText(`已打开「${path.basename(folder)}」`, { exact: false }).waitFor();
  }
  try {
    await launch(); await open(folderA); await page.locator('.chapter-list').getByRole('button', { name: file }).click();
    await page.getByRole('button', { name: '重命名', exact: true }).click(); let modal = page.getByRole('dialog', { name: '章节重命名' });
    await modal.getByRole('radio', { name: '仅在本机应用中显示' }).check(); await modal.getByLabel('新的章节名称').fill('星光序章');
    assert.equal(await modal.evaluate(element => element.scrollWidth > element.clientWidth), false, '重命名窗口不能水平溢出');
    await modal.screenshot({ path: path.join(fixture, 'chapter-display-dialog.png') });
    await modal.getByRole('button', { name: '确认重命名' }).click(); await page.getByText('本机章节显示名已更新，正文文件名未改变').waitFor();
    await page.locator('.chapter-list').getByRole('button', { name: '星光序章' }).waitFor(); await page.getByRole('heading', { name: '星光序章' }).waitFor();
    assert.equal(await fs.readFile(path.join(folderA, file), 'utf8'), textA); assert.deepEqual((await fs.readdir(folderA)).filter(name => name.endsWith('.txt')), [file]);
    await page.getByRole('button', { name: '章节排序', exact: true }).click(); await page.getByRole('dialog', { name: '章节排序' }).getByText('星光序章', { exact: true }).waitFor(); await page.getByRole('dialog', { name: '章节排序' }).getByRole('button', { name: '取消' }).click();
    await app!.evaluate(({app}) => app.exit(0)); app = null; await launch(); await open(folderA);
    await page.locator('.chapter-list').getByRole('button', { name: '星光序章' }).click(); await page.getByRole('heading', { name: '星光序章' }).waitFor();
    await open(folderB); await page.locator('.chapter-list').getByRole('button', { name: file }).waitFor(); assert.equal(await page.locator('.chapter-list').getByRole('button', { name: '星光序章' }).count(), 0);
    await open(folderA); await page.locator('.chapter-list').getByRole('button', { name: '星光序章' }).click();
    await page.getByRole('button', { name: '重命名', exact: true }).click(); modal = page.getByRole('dialog', { name: '章节重命名' });
    assert.equal(await modal.getByRole('radio', { name: '修改实际文件名' }).isChecked(), true); await modal.getByLabel('新的章节名称').fill('改过的文件名');
    await modal.getByRole('button', { name: '确认重命名' }).click(); await page.getByText('章节已重命名，原稿归档保留').waitFor();
    await page.locator('.chapter-list').getByRole('button', { name: '星光序章' }).waitFor(); assert.equal(await fs.readFile(path.join(folderA, '改过的文件名.txt'), 'utf8'), textA);
    await page.getByRole('button', { name: '重命名', exact: true }).click(); modal = page.getByRole('dialog', { name: '章节重命名' });
    await modal.getByRole('radio', { name: '仅在本机应用中显示' }).check(); assert.equal(await modal.getByLabel('新的章节名称').inputValue(), '星光序章');
    await modal.getByRole('button', { name: '恢复显示文件名' }).click(); await page.getByText('已恢复显示章节文件名').waitFor();
    await page.locator('.chapter-list').getByRole('button', { name: '改过的文件名.txt' }).waitFor(); assert.equal(await fs.readFile(path.join(folderB, file), 'utf8'), textB);
    console.log('Chapter display desktop passed: local alias, unchanged source, restart, sorting, cross-book isolation, file rename mapping and reset.');
  } finally { const active = app as ElectronApplication | null; if (active) await active.evaluate(({app}) => app.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
