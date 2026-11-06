import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const executable = String.raw`${process.env.LOCALAPPDATA}\Programs\Starwriting\beta.23\小说编写器.exe`;

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/packaged-beta23-shelf-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  try {
    app = await electron.launch({ executablePath: executable, args: [], env, timeout: 60000 });
    const identity = await app.evaluate(({ app: instance }) => ({ version: instance.getVersion(), packaged: instance.isPackaged }));
    assert.equal(identity.version, '0.1.1-beta.23');
    page = await app.firstWindow({ timeout: 45000 }); page.setDefaultTimeout(30000);
    page.on('dialog', dialog => { dialog.accept().catch(() => {}); });
    await page.evaluate(async parentDir => window.writer.createProject(parentDir, '正文', false), parent);
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, path.join(parent, '正文'));
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByRole('button', { name: '我的书架' }).click();
    const card = page.locator('.shelf-card').first();
    await card.waitFor({ timeout: 20000 });
    const metrics = await card.evaluate(element => {
      const cardElement = element as HTMLElement;
      const cover = cardElement.querySelector('.cover-button') as HTMLElement;
      return {
        direction: getComputedStyle(cardElement).flexDirection,
        width: Math.round(cardElement.getBoundingClientRect().width), height: Math.round(cardElement.getBoundingClientRect().height),
        cover: { width: Math.round(cover.getBoundingClientRect().width), height: Math.round(cover.getBoundingClientRect().height) },
        overflow: cardElement.scrollWidth - cardElement.clientWidth
      };
    });
    assert.equal(metrics.direction, 'row');
    assert.ok(metrics.cover.width <= 140 && metrics.cover.height <= 210, '封面应克制：' + JSON.stringify(metrics.cover));
    assert.ok(metrics.height <= 320, '卡片高度应紧凑：' + metrics.height);
    assert.equal(metrics.overflow, 0);
    await page.screenshot({ path: path.join(fixture, 'shelf-card.png') });
    console.log(JSON.stringify({ ok: true, identity, metrics, fixture }));
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
