import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const executable = String.raw`${process.env.LOCALAPPDATA}\Programs\Starwriting\beta.34\小说编写器.exe`;

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/beta34-check-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  try {
    app = await electron.launch({ executablePath: executable, args: [], env, timeout: 60000 });
    const identity = await app.evaluate(({ app: instance }) => ({ version: instance.getVersion(), packaged: instance.isPackaged }));
    page = await app.firstWindow({ timeout: 45000 }); page.setDefaultTimeout(30000);
    page.on('dialog', dialog => { dialog.accept().catch(() => {}); });
    await page.evaluate(async parentDir => window.writer.createProject(parentDir, '版本检查', true), parent);
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, path.join(parent, '版本检查'));
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    const sidebar = await page.locator('.new-chapter').evaluate(element => ({ whiteSpace: getComputedStyle(element).whiteSpace, fontSize: getComputedStyle(element).fontSize, height: Math.round(element.getBoundingClientRect().height) }));
    await page.getByRole('button', { name: '提示词库…' }).click();
    const prompts = page.locator('.prompts-modal');
    await prompts.waitFor({ timeout: 15000 });
    const width = await prompts.evaluate(element => Math.round(element.getBoundingClientRect().width));
    await page.screenshot({ path: path.join(fixture, 'beta34.png') });
    console.log(JSON.stringify({ identity, sidebar, promptsWidth: width, fixture }));
    assert.equal(width, 880, 'beta.34 是否包含新版提示词库样式');
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
