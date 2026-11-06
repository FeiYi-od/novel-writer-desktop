import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R6/R7：角色库 / 文风研习室 / 模型设置 三页在 100% 与 125% 缩放下无溢出、无裁剪；
// 强制配色下材质回退生效；每页留一档截图。
async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/ui-pages-'));
  const shots = path.join(fixture, 'shots'); await fs.mkdir(shots);
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  const measure = () => page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    clipped: [...document.querySelectorAll('button, input, select, textarea')]
      .filter(element => (element as HTMLElement).offsetParent !== null)
      .filter(element => element.scrollWidth > element.clientWidth + 2).length,
    blur: (() => { const topbar = document.querySelector('.app-shell > .topbar') as HTMLElement | null; return topbar ? getComputedStyle(topbar).backdropFilter : ''; })()
  }));
  const setZoom = (factor: number) => app!.evaluate(({ BrowserWindow }, value) => { BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(value); }, factor);
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(25000);
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.evaluate(async parentDir => window.writer.createProject(parentDir, '界面书', true), parent);
    await page.reload();
    await page.getByRole('button', { name: '打开作品 界面书' }).click();

    const pages = [
      { name: 'characters', open: async () => page.getByRole('button', { name: '角色库' }).click(), expectText: '角色库' },
      { name: 'styles', open: async () => page.getByRole('button', { name: '文风研习室' }).click(), expectText: '文风研习室' },
      { name: 'models', open: async () => page.getByRole('button', { name: '模型设置' }).click(), expectText: '模型设置' }
    ];
    for (const definition of pages) {
      await definition.open();
      await page.getByText(definition.expectText, { exact: false }).first().waitFor({ timeout: 15000 });
      for (const zoom of [1, 1.25]) {
        await setZoom(zoom); await page.waitForTimeout(250);
        const metrics = await measure();
        assert.ok(metrics.overflow <= 1, `${definition.name} @${zoom * 100}% 横向溢出 ${metrics.overflow}`);
        assert.equal(metrics.clipped, 0, `${definition.name} @${zoom * 100}% 有控件被裁剪`);
        await page.screenshot({ path: path.join(shots, `${definition.name}-${zoom * 100}.png`) });
      }
      await setZoom(1);
      await page.emulateMedia({ forcedColors: 'active' }); await page.waitForTimeout(150);
      const forced = await measure();
      assert.equal(forced.blur, 'none', `${definition.name} 强制配色下应关闭模糊`);
      await page.screenshot({ path: path.join(shots, `${definition.name}-forced.png`) });
      await page.emulateMedia({ forcedColors: 'none' });
    }
    const files = (await fs.readdir(shots)).sort();
    assert.equal(files.length, pages.length * 3, `截图数量不符：${files.join(',')}`);
    const sizes = await Promise.all(files.map(async file => (await fs.stat(path.join(shots, file))).size));
    assert.ok(sizes.every(size => size > 15000), '截图应包含真实界面内容');
    console.log(`UI pages desktop passed: 三页 @100%/125% 无溢出裁剪，强制配色关闭模糊；截图 ${shots}`);
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
