import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const executable = String.raw`${process.env.LOCALAPPDATA}\Programs\Starwriting\beta.27\小说编写器.exe`;

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/packaged-beta27-modals-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  try {
    app = await electron.launch({ executablePath: executable, args: [], env, timeout: 60000 });
    const identity = await app.evaluate(({ app: instance }) => ({ version: instance.getVersion(), packaged: instance.isPackaged }));
    assert.equal(identity.version, '0.1.1-beta.27');
    page = await app.firstWindow({ timeout: 45000 }); page.setDefaultTimeout(30000);
    page.on('dialog', dialog => { dialog.accept().catch(() => {}); });
    await page.evaluate(async parentDir => window.writer.createProject(parentDir, '版式书', true), parent);
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, path.join(parent, '版式书'));
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();

    await page.getByRole('button', { name: '人物关系…' }).click();
    const relations = page.getByRole('dialog', { name: '人物关系' });
    await relations.waitFor({ timeout: 20000 });
    const relationWidth = await relations.evaluate(element => Math.round(element.getBoundingClientRect().width));
    assert.ok(relationWidth <= 800 && relationWidth >= 640, '关系弹窗宽度：' + relationWidth);
    await page.screenshot({ path: path.join(fixture, 'relations.png') });
    await relations.getByRole('button', { name: '关闭' }).click();

    await page.locator('.main-nav button').nth(2).click();
    await page.getByTestId('setting-extract-open').click();
    const setting = page.getByTestId('setting-extract');
    await setting.waitFor({ timeout: 20000 });
    const metrics = await setting.evaluate(element => {
      const textarea = element.querySelector('textarea') as HTMLElement;
      const host = element as HTMLElement;
      return { width: Math.round(host.getBoundingClientRect().width), textarea: Math.round(textarea.getBoundingClientRect().width), literal: host.innerText.includes('`r`n') };
    });
    assert.ok(metrics.textarea >= 600, '设定文本框宽度：' + metrics.textarea);
    assert.equal(metrics.literal, false);
    await page.screenshot({ path: path.join(fixture, 'setting.png') });
    console.log(JSON.stringify({ ok: true, identity, relationWidth, metrics, fixture }));
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
