import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/modals-layout-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(30000);
    page.on('dialog', dialog => { dialog.accept().catch(() => {}); });
    await page.evaluate(async parentDir => window.writer.createProject(parentDir, '版式书', true), parent);
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, path.join(parent, '版式书'));
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.locator('.chapter-list button').first().click();
    await page.getByTestId('scene-open').click();
    const scene = page.getByRole('dialog', { name: '场景分析' });
    await scene.waitFor({ timeout: 20000 });
    const sceneMetrics = await scene.evaluate(element => {
      const modal = element as HTMLElement;
      const footer = modal.querySelector('footer button') as HTMLElement;
      return {
        width: Math.round(modal.getBoundingClientRect().width), height: Math.round(modal.getBoundingClientRect().height),
        padding: getComputedStyle(modal).padding, overflow: modal.scrollWidth - modal.clientWidth,
        footerRight: Math.round(footer.getBoundingClientRect().right), modalRight: Math.round(modal.getBoundingClientRect().right),
        emptySpace: Math.round(modal.getBoundingClientRect().height) - Math.round([...modal.children].reduce((sum, child) => sum + child.getBoundingClientRect().height, 0))
      };
    });
    assert.ok(sceneMetrics.width <= 700 && sceneMetrics.width >= 560, '场景分析宽度：' + sceneMetrics.width);
    assert.ok(sceneMetrics.height < 640, '场景分析不应留大片空白：' + sceneMetrics.height);
    assert.equal(sceneMetrics.overflow, 0);
    await page.screenshot({ path: path.join(fixture, 'scene.png') });
    await scene.getByRole('button', { name: '关闭' }).click();

    await page.locator('.main-nav button').nth(2).click();
    await page.getByTestId('setting-extract-open').waitFor({ timeout: 20000 });
    await page.getByTestId('setting-extract-open').click();
    const modal = page.getByTestId('setting-extract');
    await modal.waitFor({ timeout: 20000 });
    const settingsMetrics = await modal.evaluate(element => {
      const modal = element as HTMLElement;
      const textarea = modal.querySelector('textarea') as HTMLElement;
      const close = modal.querySelector('header > button') as HTMLElement;
      const label = modal.querySelector('label') as HTMLElement;
      return {
        width: Math.round(modal.getBoundingClientRect().width), textareaWidth: Math.round(textarea.getBoundingClientRect().width),
        textareaHeight: Math.round(textarea.getBoundingClientRect().height), labelWidth: Math.round(label.getBoundingClientRect().width),
        closeWhiteSpace: getComputedStyle(close).whiteSpace, closeWidth: Math.round(close.getBoundingClientRect().width),
        text: modal.innerText.includes('`r`n'), overflow: modal.scrollWidth - modal.clientWidth
      };
    });
    assert.ok(settingsMetrics.width >= 700, '设定弹窗宽度：' + settingsMetrics.width);
    assert.ok(settingsMetrics.textareaWidth >= 600, '设定文本框应占满宽度：' + settingsMetrics.textareaWidth);
    assert.ok(settingsMetrics.textareaHeight >= 160, '设定文本框应足够高：' + settingsMetrics.textareaHeight);
    assert.equal(settingsMetrics.closeWhiteSpace, 'nowrap');
    assert.equal(settingsMetrics.text, false, '不应出现字面 `r`n');
    assert.equal(settingsMetrics.overflow, 0);
    await page.screenshot({ path: path.join(fixture, 'setting.png') });
    console.log(`Modals layout passed: scene=${JSON.stringify(sceneMetrics)} setting=${JSON.stringify(settingsMetrics)} 截图 ${fixture}`);
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
