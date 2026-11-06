import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// 复现用户截图：窄栏 + 长文件名（肆虐韩娱.txt）+ 作者/作品输入，验证不再竖排/溢出
async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/source-row-layout-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const file = path.join(fixture, '肆虐韩娱.txt');
  await fs.writeFile(file, '　　都市娱乐题材的长文本样本，用来撑出文件名长度。'.repeat(400), 'utf8');
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(30000);
    page.on('dialog', dialog => { dialog.accept().catch(() => {}); });
    await page.evaluate(async parentDir => window.writer.createProject(parentDir, '长名书', false), parent);
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, path.join(parent, '长名书'));
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByRole('button', { name: '文风研习室' }).click();
    await page.getByRole('button', { name: '＋ 导入文本' }).waitFor({ timeout: 20000 });
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, file);
    await page.getByRole('button', { name: '＋ 导入文本' }).click();
    const row = page.locator('.source-row').first();
    await row.waitFor({ timeout: 20000 });
    await page.getByLabel(/作者 肆虐韩娱/).fill('虚构作者');
    await page.getByLabel(/作者 肆虐韩娱/).blur();
    const metrics = await row.evaluate(element => {
      const span = element.querySelector('.source-row-main > span') as HTMLElement;
      const panel = element.closest('.source-panel') as HTMLElement;
      const labels = element.querySelector('.source-row-labels') as HTMLElement;
      return {
        spanHeight: Math.round(span.getBoundingClientRect().height),
        lineHeight: Math.round(parseFloat(getComputedStyle(span).lineHeight) || 0),
        spanScroll: span.scrollWidth, spanClient: span.clientWidth,
        rowRight: Math.round(element.getBoundingClientRect().right), panelRight: Math.round(panel.getBoundingClientRect().right),
        labelsRight: Math.round(labels.getBoundingClientRect().right),
        labelsHeight: Math.round(labels.getBoundingClientRect().height),
        overflowX: element.scrollWidth - element.clientWidth
      };
    });
    console.log('source row metrics:', JSON.stringify(metrics));
    assert.ok(metrics.spanHeight <= 48, '文件名区最多两行（名称 + 字数），实际高度 ' + metrics.spanHeight);
    assert.ok(metrics.spanScroll <= metrics.spanClient + 1, '文件名不应撑出横向溢出');
    assert.ok(metrics.rowRight <= metrics.panelRight + 1, '参考文本行不应超出面板');
    assert.ok(metrics.labelsRight <= metrics.panelRight + 1, '作者/作品输入不应超出面板');
    assert.ok(metrics.overflowX <= 1, '行内不应出现横向滚动：' + metrics.overflowX);
    await page.locator('.source-panel').screenshot({ path: path.join(fixture, 'source-row.png') });
    console.log(`Source row layout passed: ${JSON.stringify(metrics)} 截图 ${path.join(fixture, 'source-row.png')}`);
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
