import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// 应用内确认框：样式与整体一致（非原生 confirm），并截图
async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/confirm-ui-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const corpus = path.join(fixture, '语料.txt');
  await fs.writeFile(corpus, '　　都市娱乐题材的长文本样本，用来撑出文件名长度。'.repeat(300), 'utf8');
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(30000);
    page.on('dialog', dialog => { dialog.accept().catch(() => {}); });
    await page.evaluate(async parentDir => window.writer.createProject(parentDir, '确认框书', false), parent);
    await page.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByRole('button', { name: '打开作品 确认框书' }).click();
    await page.getByRole('button', { name: '文风研习室' }).click();
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, corpus);
    await page.getByRole('button', { name: '＋ 导入文本' }).click();
    await page.waitForTimeout(800);
    const projectId = await page.evaluate(async () => (await window.writer.listProjects())[0]!.id);
    await page.evaluate(async id => { const book = await window.writer.readBook(id); await window.writer.analyzeStyle(id, '确认框文风', [book.value.sources[0]!.id], book.hash, { mode: 'sample' }); }, projectId);
    await page.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByRole('button', { name: '打开作品 确认框书' }).click();
    await page.getByRole('button', { name: '文风研习室' }).click();
    await page.locator('[data-testid^="style-remove-"]').first().click();
    const dialog = page.getByTestId('confirm-dialog');
    await dialog.waitFor({ timeout: 15000 });
    assert.match(await dialog.innerText(), /删除文风档案「确认框文风」/u);
    const style = await dialog.evaluate(element => ({ backdrop: getComputedStyle(element.closest('.confirm-overlay')!).backdropFilter, width: Math.round(element.getBoundingClientRect().width), radius: getComputedStyle(element).borderRadius }));
    assert.ok(style.width <= 400 && style.width >= 320, '确认框宽度应克制，实际 ' + style.width);
    assert.ok(parseFloat(style.radius) >= 10, '应有圆角，实际 ' + style.radius);
    await page.screenshot({ path: path.join(fixture, 'confirm-dialog.png') });
    await dialog.getByRole('button', { name: '取消' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 10000 });
    assert.equal((await page.evaluate(async id => (await window.writer.readBook(id)).value.styles.length, projectId)), 1, '取消后不能删除');
    console.log(`Confirm dialog UI passed: ${JSON.stringify(style)} 截图 ${path.join(fixture, 'confirm-dialog.png')}`);
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
