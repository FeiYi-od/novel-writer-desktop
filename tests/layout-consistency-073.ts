import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R6：布局一致性——常见窗口尺寸下无横向溢出、工具栏按钮高度在统一区间
// R7：减少动态效果时过渡为 0
async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/layout-consistency-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  const measure = async () => page.evaluate(() => {
    const heights = [...document.querySelectorAll('.actions button, .shelf-title-actions button, .character-toolbar button, .style-merge button, .style-import-book button')]
      .filter(button => (button as HTMLElement).offsetParent !== null)
      .map(button => Math.round((button as HTMLElement).getBoundingClientRect().height));
    const clipped = [...document.querySelectorAll('button, input, select')]
      .filter(element => (element as HTMLElement).offsetParent !== null)
      .filter(element => element.scrollWidth > element.clientWidth + 2).length;
    return { heights, clipped, overflow: document.documentElement.scrollWidth - window.innerWidth };
  });
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(25000);
    await page.evaluate(async parentDir => window.writer.createProject(parentDir, '布局书', true), parent);
    await page.reload();
    for (const size of [{ width: 1000, height: 720 }, { width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(250);
      const metrics = await measure();
      assert.ok(metrics.overflow <= 1, `${size.width}x${size.height} 出现横向溢出：${metrics.overflow}`);
      assert.equal(metrics.clipped, 0, `${size.width}x${size.height} 有控件内容被裁剪`);
      if (metrics.heights.length) {
        const min = Math.min(...metrics.heights), max = Math.max(...metrics.heights);
        assert.ok(min >= 26 && max <= 48, `${size.width}x${size.height} 按钮高度超出区间：${min}–${max}`);
      }
    }
    // 角色库页同样检查
    await page.getByRole('button', { name: '打开作品 布局书' }).click();
    await page.getByRole('button', { name: '角色库' }).click();
    await page.setViewportSize({ width: 1000, height: 720 }); await page.waitForTimeout(250);
    const characters = await measure();
    assert.ok(characters.overflow <= 1, '角色库窄屏横向溢出');
    assert.equal(characters.clipped, 0, '角色库有控件被裁剪');
    // 减少动态效果
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const duration = await page.evaluate(() => getComputedStyle(document.querySelector('button')!).transitionDuration);
    assert.ok(['0s', '0s, 0s', '0s, 0s, 0s'].includes(duration), `减少动态效果下过渡应为 0s，实际 ${duration}`);
    console.log('Layout consistency desktop passed: 1000/1366/1920 无横向溢出与裁剪，按钮高度统一；减少动态效果过渡为 0。');
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
