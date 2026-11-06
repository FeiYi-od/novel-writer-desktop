import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';

async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/ui-audit3-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const corpus = path.join(fixture, '语料.txt');
  await fs.writeFile(corpus, '　　长句叙述，细节密实。'.repeat(500), 'utf8');
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  const report: Record<string, unknown>[] = [];
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(25000);
    page.on('dialog', dialog => { dialog.accept().catch(() => {}); });
    const projectId = await page.evaluate(async parentDir => (await window.writer.createProject(parentDir, '巡检书', true)).project.id, parent);
    // 造两份文风（采样，不联网）
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, corpus);
    await page.evaluate(async id => { const book = await window.writer.readBook(id); await window.writer.importStyleSources(id, book.hash); }, projectId);
    await page.evaluate(async id => {
      let book = await window.writer.readBook(id);
      const source = book.value.sources[0]!.id;
      await window.writer.analyzeStyle(id, '文风甲', [source], book.hash, { mode: 'sample' });
      book = await window.writer.readBook(id);
      await window.writer.analyzeStyle(id, '文风乙', [source], book.hash, { mode: 'sample' });
    }, projectId);
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, path.join(parent, '巡检书'));
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();

    const capture = async (name: string) => {
      await page.waitForTimeout(400);
      const metrics = await page.evaluate(() => {
        const view = document.querySelector('.full-view') as HTMLElement | null;
        const overflowing = [...document.querySelectorAll('.full-view *')].filter(element => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && (rect.right > window.innerWidth + 1 || rect.left < -1);
        }).length;
        return {
          viewScroll: view ? view.scrollWidth - view.clientWidth : null,
          overflowing,
          modal: document.querySelector('.book-modal') ? (() => { const box = document.querySelector('.book-modal') as HTMLElement; return { width: Math.round(box.getBoundingClientRect().width), height: Math.round(box.getBoundingClientRect().height), overflow: box.scrollWidth - box.clientWidth }; })() : null
        };
      });
      report.push({ name, ...metrics });
      await page.screenshot({ path: path.join(fixture, name + '.png') });
    };

    for (const label of ['文风试写比较…', '文风版本与效果…']) {
      try {
        await page.getByRole('button', { name: label }).click();
        await page.locator('.book-modal').last().waitFor({ timeout: 15000 });
        await capture(label.replace('…', ''));
        await page.locator('.book-modal').last().getByRole('button', { name: /关闭|取消/u }).first().click().catch(() => {});
        await page.waitForTimeout(300);
      } catch (error) { report.push({ name: label, error: String(error).slice(0, 140) }); }
    }

    for (const label of ['恢复本书草稿', '正文版本确认']) {
      try {
        await page.getByRole('button', { name: label }).click();
        await page.waitForTimeout(600);
        await capture(label);
        await page.locator('.main-nav button').nth(1).click();
      } catch (error) { report.push({ name: label, error: String(error).slice(0, 140) }); }
    }

    for (const label of ['创作筹备', '资料转换', '朱雀检测', '知识检索']) {
      try {
        await page.locator('.topbar-more > summary').click();
        await page.getByRole('button', { name: label, exact: true }).click();
        await page.waitForTimeout(800);
        await capture(label);
      } catch (error) { report.push({ name: label, error: String(error).slice(0, 140) }); }
    }

    try {
      await page.locator('.main-nav button').nth(2).click();
      await page.waitForTimeout(700);
      await capture('角色库页面');
    } catch (error) { report.push({ name: '角色库页面', error: String(error).slice(0, 140) }); }

    console.log(JSON.stringify(report, null, 1));
    console.log('fixture', fixture);
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
