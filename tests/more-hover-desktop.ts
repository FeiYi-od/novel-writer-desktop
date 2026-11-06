import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/more-hover-'));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [path.resolve('out/main/index.js')], env });
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(12000);
    const more = page.locator('.topbar-more > summary');
    const panel = page.locator('.topbar-more-panel');
    const details = page.locator('.topbar-more');
    for (const width of [1000, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.mouse.move(0, 0);
      await page.getByRole('button', { name: '我的书架', exact: true }).focus();
      await more.hover();
      await panel.waitFor({ state: 'visible' });
      const box = await panel.boundingBox(); assert.ok(box);
      assert.ok(box.x >= 0 && box.x + box.width <= width, '菜单不得超出窗口');
      await panel.hover({ position: { x: 15, y: 15 } });
      await page.waitForTimeout(300);
      assert.equal(await details.evaluate(el => (el as HTMLDetailsElement).open), true, '鼠标移入菜单后不应关闭');
      await page.mouse.move(0, 0); await page.waitForTimeout(300);
      assert.equal(await details.evaluate(el => (el as HTMLDetailsElement).open), false, '鼠标离开应关闭');
      await more.focus(); await page.keyboard.press('Enter');
      assert.equal(await details.evaluate(el => (el as HTMLDetailsElement).open), true, '键盘可打开');
      await page.keyboard.press('Escape');
      assert.equal(await more.evaluate(el => el === document.activeElement), true, 'Escape恢复焦点');
      await more.hover(); await page.mouse.move(0, 0); await page.waitForTimeout(300);
      assert.equal(await details.evaluate(el => (el as HTMLDetailsElement).open), false, 'Escape恢复焦点后悬停仍可离开关闭');
      const aligned = await more.evaluate(el => {
        const parent = el.getBoundingClientRect(), arrow = el.querySelector('svg')!.getBoundingClientRect();
        return Math.abs((parent.top + parent.bottom) / 2 - (arrow.top + arrow.bottom) / 2);
      });
      assert.ok(aligned <= 1, '箭头应垂直居中');
    }
    await page.screenshot({ path: path.join(fixture, 'more-menu.png') });
    console.log(`More hover desktop passed: ${fixture}`);
  } finally { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
