import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const executable = String.raw`${process.env.LOCALAPPDATA}\Programs\Starwriting\beta.28\小说编写器.exe`;

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/packaged-beta28-panels-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  try {
    app = await electron.launch({ executablePath: executable, args: [], env, timeout: 60000 });
    const identity = await app.evaluate(({ app: instance }) => ({ version: instance.getVersion(), packaged: instance.isPackaged }));
    assert.equal(identity.version, '0.1.1-beta.28');
    page = await app.firstWindow({ timeout: 45000 }); page.setDefaultTimeout(30000);
    page.on('dialog', dialog => { dialog.accept().catch(() => {}); });
    await page.evaluate(async parentDir => window.writer.createProject(parentDir, '巡检书', true), parent);
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, path.join(parent, '巡检书'));
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    const results: unknown[] = [];
    for (const [label, expectedWidth] of [['故事时间线…', 780], ['人物状态…', 780], ['提示词库…', 880]] as const) {
      await page.getByRole('button', { name: label }).click();
      const modal = page.locator('.book-modal').last();
      await modal.waitFor({ timeout: 15000 });
      const metrics = await modal.evaluate(element => {
        const box = element as HTMLElement;
        const narrow = [...box.querySelectorAll('input:not([type=checkbox]), select, textarea')].filter(input => input.getBoundingClientRect().width > 0 && input.getBoundingClientRect().width < 80).length;
        return { width: Math.round(box.getBoundingClientRect().width), height: Math.round(box.getBoundingClientRect().height), overflow: box.scrollWidth - box.clientWidth, narrow };
      });
      assert.equal(metrics.width, expectedWidth, label + ' 宽度');
      assert.equal(metrics.overflow, 0);
      assert.equal(metrics.narrow, 0, label + ' 仍有过窄输入框');
      results.push({ label, ...metrics });
      await page.screenshot({ path: path.join(fixture, label.replace('…', '') + '.png') });
      await modal.getByRole('button', { name: '关闭' }).first().click().catch(() => {});
      await page.waitForTimeout(250);
    }
    console.log(JSON.stringify({ ok: true, identity, results, fixture }));
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
