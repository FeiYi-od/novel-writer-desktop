import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// UI：更多功能面板分组 + 文风删除按钮层级（本地，不联网）
async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/more-menu-ui-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const corpus = path.join(fixture, '语料.txt');
  await fs.writeFile(corpus, '　　长篇叙述，句子较长，描写细密。'.repeat(400), 'utf8');
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(30000);
    page.on('dialog', dialog => { dialog.accept().catch(() => {}); });
    const projectId = await page.evaluate(async parentDir => (await window.writer.createProject(parentDir, '界面书', false)).project.id, parent);
    await page.reload();
    await page.getByRole('button', { name: '打开作品 界面书' }).click();
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, corpus);
    await page.getByRole('button', { name: '文风研习室' }).click();
    await page.getByRole('button', { name: '＋ 导入文本' }).click();
    await page.waitForTimeout(800);
    await page.evaluate(async id => {
      let book = await window.writer.readBook(id);
      book = await window.writer.analyzeStyle(id, '界面文风', [book.value.sources[0]!.id], book.hash, { mode: 'sample' });
      return book;
    }, projectId);
    await page.reload();
    await page.getByRole('button', { name: '打开作品 界面书' }).click();
    await page.getByRole('button', { name: '文风研习室' }).click();
    const remove = page.locator('.style-remove').first();
    await remove.waitFor({ timeout: 20000 });
    const color = await remove.evaluate(element => getComputedStyle(element).color);
    assert.equal(color, 'rgb(138, 75, 69)', '删除按钮应使用独立危险色，实际 ' + color);
    await page.getByRole('button', { name: '文风研习室' }).screenshot({ path: path.join(fixture, 'style-delete.png') }).catch(() => {});
    await page.locator('.style-card').first().screenshot({ path: path.join(fixture, 'style-delete.png') });
    await page.locator('.topbar-more > summary').click();
    const panel = page.getByLabel('更多功能');
    await panel.waitFor({ timeout: 10000 });
    const titles = await panel.locator('.more-group-title').allInnerTexts();
    assert.deepEqual(titles, ['创作工具', '检查与统计', '应用']);
    await page.screenshot({ path: path.join(fixture, 'more-menu.png') });
    console.log(`More menu UI passed: 三组标题 ${titles.join('/')}；删除按钮配色 ${color}；截图 ${fixture}`);
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
