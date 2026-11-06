import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';

// 批量巡检各弹窗版式：宽度、横向溢出、头部按钮是否换行、输入框是否过窄
async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/modals-audit-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  const report: unknown[] = [];
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(20000);
    page.on('dialog', dialog => { dialog.accept().catch(() => {}); });
    await page.evaluate(async parentDir => window.writer.createProject(parentDir, '巡检书', true), parent);
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, path.join(parent, '巡检书'));
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();

    const tools: { name: string; open: () => Promise<void> }[] = [
      { name: '章节排序', open: async () => { await page.getByRole('button', { name: '章节排序' }).click(); } },
      { name: '故事时间线', open: async () => { await page.getByRole('button', { name: '故事时间线…' }).click(); } },
      { name: '人物状态', open: async () => { await page.getByRole('button', { name: '人物状态…' }).click(); } },
      { name: '提示词库', open: async () => { await page.getByRole('button', { name: '提示词库…' }).click(); } },
      { name: '用量统计', open: async () => { await page.locator('.topbar-more > summary').click(); await page.getByTestId('usage-open').click(); } }
    ];
    for (const tool of tools) {
      await tool.open();
      const modal = page.locator('.book-modal').last();
      try { await modal.waitFor({ timeout: 15000 }); } catch { report.push({ tool: tool.name, error: 'modal not found' }); continue; }
      const metrics = await modal.evaluate(element => {
        const modal = element as HTMLElement;
        const headerButton = modal.querySelector(':scope > header > button') as HTMLElement | null;
        const narrowInputs = [...modal.querySelectorAll('input:not([type=checkbox]), select, textarea')].filter(input => {
          const rect = input.getBoundingClientRect();
          return rect.width > 0 && rect.width < 80;
        }).map(input => ({ tag: input.tagName, width: Math.round(input.getBoundingClientRect().width) }));
        return {
          title: modal.querySelector('h2')?.textContent ?? '',
          width: Math.round(modal.getBoundingClientRect().width), height: Math.round(modal.getBoundingClientRect().height),
          overflowX: modal.scrollWidth - modal.clientWidth,
          headerButton: headerButton ? { height: Math.round(headerButton.getBoundingClientRect().height), width: Math.round(headerButton.getBoundingClientRect().width) } : null,
          narrowInputs
        };
      });
      report.push({ tool: tool.name, ...metrics });
      await page.screenshot({ path: path.join(fixture, `${tool.name}.png`) });
      const close = modal.getByRole('button', { name: '关闭' });
      if (await close.count()) await close.first().click().catch(() => {});
      await page.waitForTimeout(300);
      await page.keyboard.press('Escape').catch(() => {});
    }
    console.log(JSON.stringify(report, null, 1));
    console.log('fixture', fixture);
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
