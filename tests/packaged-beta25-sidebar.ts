import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const executable = String.raw`${process.env.LOCALAPPDATA}\Programs\Starwriting\beta.25\小说编写器.exe`;

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/packaged-beta25-sidebar-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  try {
    app = await electron.launch({ executablePath: executable, args: [], env, timeout: 60000 });
    const identity = await app.evaluate(({ app: instance }) => ({ version: instance.getVersion(), packaged: instance.isPackaged }));
    assert.equal(identity.version, '0.1.1-beta.25');
    page = await app.firstWindow({ timeout: 45000 }); page.setDefaultTimeout(30000);
    page.on('dialog', dialog => { dialog.accept().catch(() => {}); });
    await page.evaluate(async parentDir => window.writer.createProject(parentDir, '正文', true), parent);
    const chapters = path.join(parent, '正文', '正文'); await fs.mkdir(chapters, { recursive: true });
    await fs.writeFile(path.join(chapters, '校花同桌是我的小母狗（1）.docx'), '');
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, path.join(parent, '正文'));
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    const button = page.locator('.new-chapter');
    await button.waitFor({ timeout: 20000 });
    const metrics = await button.evaluate(element => {
      const style = getComputedStyle(element);
      return { height: Math.round(element.getBoundingClientRect().height), width: Math.round(element.getBoundingClientRect().width), whiteSpace: style.whiteSpace, fontSize: style.fontSize, overflow: element.scrollWidth - element.clientWidth, text: element.textContent?.trim() };
    });
    assert.equal(metrics.whiteSpace, 'nowrap');
    assert.equal(metrics.fontSize, '12px');
    assert.ok(metrics.height <= 36, '按钮应单行：' + metrics.height);
    assert.ok(metrics.overflow <= 1, '文字不应溢出：' + metrics.overflow);
    await page.locator('.sidebar').screenshot({ path: path.join(fixture, 'sidebar.png') });
    console.log(JSON.stringify({ ok: true, identity, metrics, fixture }));
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
