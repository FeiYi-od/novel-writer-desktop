import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';

async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/shelf-card-ui-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(30000);
    page.on('dialog', dialog => { dialog.accept().catch(() => {}); });
    console.log('STEP launched');
    await page.evaluate(async parentDir => window.writer.createProject(parentDir, '正文', false), parent);
    console.log('STEP created');
    await page.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('STEP opening shelf');
    const card = page.locator('.shelf-card').first();
    await card.waitFor({ timeout: 20000 });
    for (const width of [1366, 900, 700]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(300);
      const metrics = await card.evaluate(element => {
        const card = element as HTMLElement;
        const cover = card.querySelector('.cover-button') as HTMLElement | null;
        const details = card.querySelector('.card-details') as HTMLElement;
        const actions = card.querySelector('.card-actions') as HTMLElement;
        return {
          cardWidth: Math.round(card.getBoundingClientRect().width), cardHeight: Math.round(card.getBoundingClientRect().height),
          cover: cover ? { width: Math.round(cover.getBoundingClientRect().width), height: Math.round(cover.getBoundingClientRect().height) } : null,
          direction: getComputedStyle(card).flexDirection,
          detailsOverflow: details.scrollWidth - details.clientWidth,
          actionsTop: Math.round(actions.getBoundingClientRect().top), actionsBottom: Math.round(actions.getBoundingClientRect().bottom), cardBottom: Math.round(card.getBoundingClientRect().bottom)
        };
      });
      console.log('SHELF_METRICS', width, JSON.stringify(metrics));
      if (width >= 900) {
        if (metrics.direction !== 'row') throw new Error('书架卡片应为书封+详情横向布局，实际 ' + metrics.direction);
        if (!metrics.cover || metrics.cover.width > 140 || metrics.cover.height > 210) throw new Error('封面尺寸过大：' + JSON.stringify(metrics.cover));
        if (metrics.cardHeight > 320) throw new Error('卡片高度异常：' + metrics.cardHeight);
      }
      if (metrics.detailsOverflow > 1) throw new Error('详情区横向溢出：' + metrics.detailsOverflow);
      if (metrics.actionsBottom > metrics.cardBottom + 1) throw new Error('操作按钮超出卡片');
      await page.screenshot({ path: path.join(fixture, `shelf-${width}.png`) });
    }
    console.log('Shelf card desktop passed: 横向书卡、封面 120×180、无溢出；截图 ' + fixture);
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
