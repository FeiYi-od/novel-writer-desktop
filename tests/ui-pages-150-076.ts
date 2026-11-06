import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R6：150% 缩放、空列表文案、键盘焦点；R7：强制配色截图
async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/ui-pages-150-'));
  const shots = path.join(fixture, 'shots'); await fs.mkdir(shots);
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  const measure = () => page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    clipped: [...document.querySelectorAll('button, input, select, textarea')]
      .filter(element => (element as HTMLElement).offsetParent !== null)
      .filter(element => element.scrollWidth > element.clientWidth + 2).length
  }));
  const setZoom = (factor: number) => app!.evaluate(({ BrowserWindow }, value) => { BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(value); }, factor);
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(25000);
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.evaluate(async parentDir => window.writer.createProject(parentDir, '一百五十', true), parent);
    await page.reload();

    // 空书架搜索：空状态文案必须可见
    await page.getByLabel('搜索书架').fill('不存在的书名');
    await page.getByText('没有找到这部作品').waitFor({ timeout: 10000 });
    await page.getByLabel('搜索书架').fill('');

    await page.getByRole('button', { name: '打开作品 一百五十' }).click();
    const pages = [
      { name: 'characters', open: async () => page.getByRole('button', { name: '角色库' }).click(), empty: '导入图片角色卡' },
      { name: 'styles', open: async () => page.getByRole('button', { name: '文风研习室' }).click(), empty: '导入一段喜欢的小说文本' },
      { name: 'models', open: async () => page.getByRole('button', { name: '模型设置' }).click(), empty: '新增模型连接' }
    ];
    for (const definition of pages) {
      await definition.open();
      await page.getByText(definition.empty, { exact: false }).first().waitFor({ timeout: 15000 });
      for (const zoom of [1.5, 1.25]) {
        await setZoom(zoom); await page.waitForTimeout(250);
        const metrics = await measure();
        assert.ok(metrics.overflow <= 1, `${definition.name} @${zoom * 100}% 横向溢出 ${metrics.overflow}`);
        assert.equal(metrics.clipped, 0, `${definition.name} @${zoom * 100}% 有控件被裁剪`);
        await page.screenshot({ path: path.join(shots, `${definition.name}-${Math.round(zoom * 100)}.png`) });
      }
      await setZoom(1);
    }

    // 键盘焦点：Tab 后焦点必须落在可交互元素且可见
    await page.getByRole('button', { name: '角色库' }).click();
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element) return null;
      const style = getComputedStyle(element);
      return { tag: element.tagName, text: element.textContent?.slice(0, 12) ?? '', outlineWidth: style.outlineWidth, outlineStyle: style.outlineStyle };
    });
    assert.ok(focus, 'Tab 后应有焦点元素');
    assert.ok(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A', 'SUMMARY'].includes(focus!.tag), `焦点应落在可交互元素，实际 ${focus!.tag}`);
    assert.ok(focus!.outlineStyle !== 'none' || focus!.outlineWidth !== '0px', '键盘焦点应有可见轮廓');

    // 强制配色截图（角色库）
    await page.emulateMedia({ forcedColors: 'active' }); await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(shots, 'characters-forced.png') });
    await page.emulateMedia({ forcedColors: 'none' });

    const files = (await fs.readdir(shots)).sort();
    assert.equal(files.length, 7, `截图数量不符：${files.join(',')}`);
    const sizes = await Promise.all(files.map(async file => (await fs.stat(path.join(shots, file))).size));
    assert.ok(sizes.every(size => size > 15000), '截图应包含真实界面内容');
    console.log(`UI 150% desktop passed: 150%/125% 无溢出裁剪，空状态与键盘焦点正常；截图 ${shots}`);
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
