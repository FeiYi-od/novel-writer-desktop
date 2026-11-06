import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const executable = String.raw`${process.env.LOCALAPPDATA}\Programs\Starwriting\beta.21\小说编写器.exe`;

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/packaged-beta21-row-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const file = path.join(fixture, '肆虐韩娱.txt');
  await fs.writeFile(file, '　　都市娱乐题材的长文本样本，用来撑出文件名长度。'.repeat(400), 'utf8');
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  try {
    app = await electron.launch({ executablePath: executable, args: [], env, timeout: 60000 });
    const identity = await app.evaluate(({ app: instance }) => ({ version: instance.getVersion(), packaged: instance.isPackaged }));
    assert.equal(identity.version, '0.1.1-beta.21');
    assert.equal(identity.packaged, true);
    page = await app.firstWindow({ timeout: 45000 }); page.setDefaultTimeout(30000);
    page.on('dialog', dialog => { dialog.accept().catch(() => {}); });
    await page.evaluate(async parentDir => window.writer.createProject(parentDir, '长名书', false), parent);
    await page.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByRole('button', { name: '打开作品 长名书' }).click();
    await page.getByRole('button', { name: '文风研习室' }).click();
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, file);
    await page.getByRole('button', { name: '＋ 导入文本' }).click();
    const row = page.locator('.source-row').first();
    await row.waitFor({ timeout: 20000 });
    await page.getByLabel(/作者 肆虐韩娱/).fill('虚构作者');
    await page.getByLabel(/作者 肆虐韩娱/).blur();
    const metrics = await row.evaluate(element => {
      const span = element.querySelector('.source-row-main > span') as HTMLElement;
      const panel = element.closest('.source-panel') as HTMLElement;
      return {
        spanHeight: Math.round(span.getBoundingClientRect().height),
        spanScroll: span.scrollWidth, spanClient: span.clientWidth,
        rowRight: Math.round(element.getBoundingClientRect().right), panelRight: Math.round(panel.getBoundingClientRect().right),
        overflowX: element.scrollWidth - element.clientWidth
      };
    });
    assert.ok(metrics.spanHeight <= 48, '文件名区最多两行');
    assert.ok(metrics.rowRight <= metrics.panelRight + 1, '行不应超出面板');
    assert.equal(metrics.overflowX, 0, '不应出现横向滚动');
    await page.locator('.source-panel').screenshot({ path: path.join(fixture, 'source-row.png') });
    console.log(JSON.stringify({ ok: true, identity, metrics, fixture }));
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
