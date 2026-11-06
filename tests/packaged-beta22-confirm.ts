import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const executable = String.raw`${process.env.LOCALAPPDATA}\Programs\Starwriting\beta.22\小说编写器.exe`;

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/packaged-beta22-confirm-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  try {
    app = await electron.launch({ executablePath: executable, args: [], env, timeout: 60000 });
    const identity = await app.evaluate(({ app: instance }) => ({ version: instance.getVersion(), packaged: instance.isPackaged }));
    assert.equal(identity.version, '0.1.1-beta.22');
    assert.equal(identity.packaged, true);
    page = await app.firstWindow({ timeout: 45000 }); page.setDefaultTimeout(30000);
    page.on('dialog', dialog => { dialog.accept().catch(() => {}); });
    await page.evaluate(async parentDir => window.writer.createProject(parentDir, '桌面确认框书', false), parent);
    await page.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByRole('button', { name: '打开作品 桌面确认框书' }).click();
    await page.getByRole('button', { name: '文风研习室' }).click();
    const projectId = await page.evaluate(async () => (await window.writer.listProjects())[0]!.id);
    const corpus = path.join(fixture, '语料.txt'); await fs.writeFile(corpus, '　　桌面确认框测试语料。'.repeat(400), 'utf8');
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, corpus);
    await page.getByRole('button', { name: '＋ 导入文本' }).click();
    await page.waitForTimeout(800);
    await page.evaluate(async id => { const book = await window.writer.readBook(id); await window.writer.analyzeStyle(id, '桌面确认框', [book.value.sources[0]!.id], book.hash, { mode: 'sample' }); }, projectId);
    await page.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByRole('button', { name: '打开作品 桌面确认框书' }).click();
    await page.getByRole('button', { name: '文风研习室' }).click();
    await page.locator('[data-testid^="style-remove-"]').first().click();
    const dialog = page.getByTestId('confirm-dialog');
    await dialog.waitFor({ timeout: 15000 });
    assert.match(await dialog.innerText(), /删除文风档案「桌面确认框」/u);
    await page.screenshot({ path: path.join(fixture, 'confirm-dialog.png') });
    await dialog.getByRole('button', { name: '取消' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 10000 });
    console.log(JSON.stringify({ ok: true, identity, fixture }));
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
