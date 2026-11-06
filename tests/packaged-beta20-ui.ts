import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// 直接验证“桌面版”部署目录里的实际 EXE：版本号、更多功能分组、文风删除配色
const executable = String.raw`${process.env.LOCALAPPDATA}\Programs\Starwriting\beta.20\小说编写器.exe`;

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/packaged-beta20-ui-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const corpus = path.join(fixture, '语料.txt');
  await fs.writeFile(corpus, '　　长篇叙述，句子较长，描写细密。'.repeat(400), 'utf8');
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  try {
    app = await electron.launch({ executablePath: executable, args: [], env, timeout: 60000 });
    const identity = await app.evaluate(({ app: instance }) => ({ version: instance.getVersion(), packaged: instance.isPackaged, exe: instance.getPath('exe') }));
    assert.equal(identity.version, '0.1.1-beta.20');
    assert.equal(identity.packaged, true);
    page = await app.firstWindow({ timeout: 45000 }); page.setDefaultTimeout(30000);
    page.on('dialog', dialog => { dialog.accept().catch(() => {}); });
    const projectId = await page.evaluate(async parentDir => (await window.writer.createProject(parentDir, '桌面版界面书', false)).project.id, parent);
    await page.reload();
    await page.getByRole('button', { name: '打开作品 桌面版界面书' }).click();
    await page.locator('.topbar-more > summary').click();
    const panel = page.getByLabel('更多功能');
    await panel.waitFor({ timeout: 15000 });
    assert.deepEqual(await panel.locator('.more-group-title').allInnerTexts(), ['创作工具', '检查与统计', '应用']);
    await page.keyboard.press('Escape');
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, corpus);
    await page.getByRole('button', { name: '文风研习室' }).click();
    await page.getByRole('button', { name: '＋ 导入文本' }).click();
    await page.waitForTimeout(800);
    await page.evaluate(async id => { const book = await window.writer.readBook(id); await window.writer.analyzeStyle(id, '桌面版文风', [book.value.sources[0]!.id], book.hash, { mode: 'sample' }); }, projectId);
    await page.reload();
    await page.getByRole('button', { name: '打开作品 桌面版界面书' }).click();
    await page.getByRole('button', { name: '文风研习室' }).click();
    const remove = page.locator('.style-remove').first();
    await remove.waitFor({ timeout: 20000 });
    assert.equal(await remove.evaluate(element => getComputedStyle(element).color), 'rgb(138, 75, 69)');
    await page.locator('.style-card').first().screenshot({ path: path.join(fixture, 'style-delete.png') });
    await page.locator('.topbar-more > summary').click();
    await page.screenshot({ path: path.join(fixture, 'more-menu.png') });
    console.log(JSON.stringify({ ok: true, identity, fixture }));
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
