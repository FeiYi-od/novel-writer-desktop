import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/folder-rename-desktop-'));
  const folderA = path.join(fixture, '虚构目录甲'), folderB = path.join(fixture, '已有目录乙'); await fs.mkdir(folderA); await fs.mkdir(folderB);
  const file = '第一章.txt', textA = '　　虚构甲正文。', textB = '　　虚构乙正文。'; await fs.writeFile(path.join(folderA, file), textA); await fs.writeFile(path.join(folderB, file), textB);
  const args = process.argv.slice(2); assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--exe' && path.isAbsolute(args[1]!)));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null; let page!: Page;
  async function launch() {
    app = await electron.launch({ executablePath: args.length ? args[1]! : createRequire(import.meta.url)('electron'), args: args.length ? [] : [path.resolve('out/main/index.js')], env });
    if (args.length) { const info = await app.evaluate(({app}) => ({ packaged: app.isPackaged, version: app.getVersion() })); assert.equal(info.packaged, true); assert.equal(info.version, JSON.parse(await fs.readFile('package.json', 'utf8')).version); }
    page = await app.firstWindow(); page.setDefaultTimeout(30000); await page.setViewportSize({ width: 1000, height: 720 }); page.on('dialog', dialog => void dialog.accept());
  }
  try {
    await launch(); await app!.evaluate(({dialog}, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folderA);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click(); await page.getByText('已打开「虚构目录甲」', { exact: false }).waitFor();
    const id = (await page.evaluate(() => window.writer.listProjects()))[0]!.id;
    await page.locator('.chapter-list').getByRole('button', { name: file }).click();
    await page.locator('.tiptap').fill('尚未保存的虚构修改。'); await page.getByRole('button', { name: '我的书架', exact: true }).click();
    await page.getByRole('button', { name: '修改文件夹名称 虚构目录甲' }).click(); let modal = page.getByRole('dialog', { name: '小说文件夹改名' });
    await modal.getByLabel('新的小说文件夹名称').fill('测试新目录'); await modal.getByRole('button', { name: '确认修改文件夹' }).click();
    await modal.getByRole('alert').getByText(/请先保存正文/u).waitFor(); assert.equal(await fs.readFile(path.join(folderA, file), 'utf8'), textA);
    await modal.getByRole('button', { name: '取消' }).click(); await page.getByRole('button', { name: '写作空间', exact: true }).click();
    await page.getByRole('button', { name: '保存 TXT', exact: true }).click(); await page.getByText('TXT 已保存到所选文件夹', { exact: true }).waitFor();
    const saved = await fs.readFile(path.join(folderA, file)); const meta = await fs.readFile(path.join(folderA, '小说资料', 'project.json'));
    await page.getByRole('button', { name: '我的书架', exact: true }).click(); await page.getByRole('button', { name: '修改文件夹名称 虚构目录甲' }).click(); modal = page.getByRole('dialog', { name: '小说文件夹改名' });
    await modal.getByLabel('新的小说文件夹名称').fill('已有目录乙'); await modal.getByRole('button', { name: '确认修改文件夹' }).click(); await modal.getByRole('alert').getByText(/目标文件夹已存在/u).waitFor();
    assert.equal(await fs.readFile(path.join(folderB, file), 'utf8'), textB); assert.deepEqual(await fs.readFile(path.join(folderA, file)), saved);
    await modal.getByLabel('新的小说文件夹名称').fill('改名后的目录');
    assert.equal(await modal.evaluate(element => element.scrollWidth > element.clientWidth), false); await modal.screenshot({ path: path.join(fixture, 'folder-rename-dialog.png') });
    await modal.getByRole('button', { name: '确认修改文件夹' }).click(); await page.getByText('文件夹已改名为「改名后的目录」，请从书架重新打开作品。').waitFor();
    const renamed = path.join(fixture, '改名后的目录'); assert.deepEqual(await fs.readFile(path.join(renamed, file)), saved); assert.deepEqual(await fs.readFile(path.join(renamed, '小说资料', 'project.json')), meta); await assert.rejects(fs.lstat(folderA), /ENOENT/u);
    assert.equal((await page.evaluate(() => window.writer.listProjects())).find(project => project.id === id)?.root, renamed);
    await page.getByRole('button', { name: '打开作品 虚构目录甲' }).click(); await page.locator('.chapter-list').getByRole('button', { name: file }).click(); assert.match(await page.locator('.tiptap').innerText(), /尚未保存的虚构修改/u);
    await app!.evaluate(({app}) => app.exit(0)); app = null; await launch();
    await page.getByRole('button', { name: '打开作品 虚构目录甲' }).click(); await page.locator('.chapter-list').getByRole('button', { name: file }).click(); assert.match(await page.locator('.tiptap').innerText(), /尚未保存的虚构修改/u);
    assert.equal(await fs.readFile(path.join(folderB, file), 'utf8'), textB);
    console.log('Project folder rename desktop passed: dirty guard, no replacement, updated identity and index, source bytes and restart.');
  } finally { const active = app as ElectronApplication | null; if (active) await active.evaluate(({app}) => app.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
