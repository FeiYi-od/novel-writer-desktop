import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R7：材质 token 生效 + 强制配色/减少透明/减少动效的回退（截图留档，不宣称观感验收）
async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/liquid-glass-'));
  const shots = path.join(fixture, 'shots'); await fs.mkdir(shots);
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  const glass = () => page.evaluate(() => {
    const topbar = document.querySelector('.app-shell > .topbar') as HTMLElement | null;
    const style = topbar ? getComputedStyle(topbar) : null;
    return {
      blur: style?.backdropFilter ?? '',
      background: style?.backgroundColor ?? '',
      shadow: style?.boxShadow ?? '',
      reduced: matchMedia('(prefers-reduced-transparency: reduce)').matches,
      forced: matchMedia('(forced-colors: active)').matches
    };
  });
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(25000);
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.screenshot({ path: path.join(shots, 'shelf-normal.png') });
    const normal = await glass();
    assert.match(normal.blur, /blur\((18|24)px\)/u, `顶栏应使用材质模糊，实际 ${normal.blur}`);
    assert.ok(!normal.forced && !normal.reduced);

    await page.emulateMedia({ forcedColors: 'active' });
    await page.waitForTimeout(150);
    const forced = await glass();
    assert.equal(forced.forced, true);
    assert.equal(forced.blur, 'none', '强制配色下必须关闭模糊');
    assert.equal(forced.shadow, 'none', '强制配色下必须关闭阴影');
    await page.screenshot({ path: path.join(shots, 'shelf-forced-colors.png') });

    await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'reduce' });
    await page.waitForTimeout(150);
    const reducedDuration = await page.evaluate(() => getComputedStyle(document.querySelector('.app-shell button')!).transitionDuration);
    assert.ok(reducedDuration.split(',').every(part => part.trim() === '0s'), `减少动效下过渡应为 0s，实际 ${reducedDuration}`);
    await page.screenshot({ path: path.join(shots, 'shelf-reduced-motion.png') });

    const files = await fs.readdir(shots);
    assert.deepEqual(files.sort(), ['shelf-forced-colors.png', 'shelf-normal.png', 'shelf-reduced-motion.png']);
    const sizes = await Promise.all(files.map(async file => (await fs.stat(path.join(shots, file))).size));
    assert.ok(sizes.every(size => size > 20000), '截图应包含真实界面内容');
    console.log(`Liquid glass desktop passed: 材质 token 生效，强制配色/减少动效回退正确；截图：${shots}`);
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
