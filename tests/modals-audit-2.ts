import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';

async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/modals-audit2-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  const report: Record<string, unknown>[] = [];
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(20000);
    page.on('dialog', dialog => { dialog.accept().catch(() => {}); });
    await page.evaluate(async parentDir => window.writer.createProject(parentDir, '巡检书', true), parent);
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, path.join(parent, '巡检书'));
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();

    const tools: { name: string; open: () => Promise<void> }[] = [
      { name: '世界书', open: async () => { await page.getByTestId('world-open').click(); } },
      { name: '宏观分析', open: async () => { await page.getByTestId('macro-open').click(); } },
      { name: '分卷蓝图', open: async () => { await page.getByRole('button', { name: '分卷与章节蓝图…' }).click(); } },
      { name: '固定资料同步', open: async () => { await page.getByTestId('material-sync-open').click(); } },
      { name: '整书替换', open: async () => { await page.getByRole('button', { name: '整书替换…' }).click(); } },
      { name: '与模型讨论', open: async () => { await page.getByTestId('discussion-open').click(); } },
      { name: '接入API', open: async () => { await page.getByTestId('connect-open').click(); } },
      { name: '密钥状态', open: async () => { await page.getByTestId('keys-open').click(); } },
      { name: '文件夹与备份', open: async () => { await page.getByTestId('nas-open').click(); } },
      { name: '用量统计', open: async () => { await page.locator('.topbar-more > summary').click(); await page.getByTestId('usage-open').click(); } },
      { name: '检查更新', open: async () => { await page.locator('.topbar-more > summary').click(); await page.getByTestId('update-open').click(); } }
    ];
    for (const tool of tools) {
      try {
        await tool.open();
        const modal = page.locator('.book-modal, .modal').last();
        await modal.waitFor({ timeout: 12000 });
        const metrics = await modal.evaluate(element => {
          const box = element as HTMLElement;
          const narrow = [...box.querySelectorAll('input:not([type=checkbox]), select, textarea')].filter(input => {
            const rect = input.getBoundingClientRect();
            return rect.width > 0 && rect.width < 80;
          }).length;
          const headerButton = box.querySelector(':scope > header > button') as HTMLElement | null;
          return {
            title: box.querySelector('h2')?.textContent ?? '',
            width: Math.round(box.getBoundingClientRect().width), height: Math.round(box.getBoundingClientRect().height),
            overflowX: box.scrollWidth - box.clientWidth, narrow,
            headerButton: headerButton ? { width: Math.round(headerButton.getBoundingClientRect().width), height: Math.round(headerButton.getBoundingClientRect().height) } : null
          };
        });
        report.push({ tool: tool.name, ...metrics });
        await page.screenshot({ path: path.join(fixture, `${tool.name}.png`) });
      } catch (error) {
        report.push({ tool: tool.name, error: String(error instanceof Error ? error.message : error).slice(0, 160) });
      }
      for (const name of ['关闭', '取消']) {
        const button = page.locator('.book-modal, .modal').last().getByRole('button', { name });
        if (await button.count()) { await button.first().click().catch(() => {}); break; }
      }
      await page.waitForTimeout(250);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(150);
    }
    console.log(JSON.stringify(report, null, 1));
    console.log('fixture', fixture);
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
