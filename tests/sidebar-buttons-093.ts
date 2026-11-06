import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';

async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/sidebar-buttons-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(30000);
    page.on('dialog', dialog => { dialog.accept().catch(() => {}); });
    await page.evaluate(async parentDir => window.writer.createProject(parentDir, '正文', true), parent);
    const chapters = path.join(parent, '正文', '正文'); await fs.mkdir(chapters, { recursive: true });
    await fs.writeFile(path.join(chapters, '校花同桌是我的小母狗（1）.docx'), '');
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, path.join(parent, '正文'));
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.locator('.new-chapter').waitFor({ timeout: 20000 });
    const rows = await page.locator('.new-chapter, .import-chapters, .sidebar-tools-content > button, .chapter-list button').evaluateAll(buttons => buttons.map(button => {
      const style = getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      return { text: (button.textContent ?? '').trim().slice(0, 24), width: Math.round(rect.width), height: Math.round(rect.height), scrollWidth: button.scrollWidth, fontSize: style.fontSize, whiteSpace: style.whiteSpace, padding: style.padding, lineHeight: style.lineHeight };
    }));
    console.log(JSON.stringify(rows.filter(row => row.scrollWidth > row.width + 1 || row.height > 44), null, 1));
    if (rows.some(row => row.height > 44)) throw new Error('侧栏按钮出现多行');
    if (rows.some(row => row.scrollWidth > row.width + 1)) throw new Error('侧栏按钮文字横向溢出');
    const newChapter = rows.find(row => row.text.includes('新建'));
    if (!newChapter || newChapter.height > 40) throw new Error('新建章节按钮应单行：' + JSON.stringify(newChapter));
    console.log('SIDEBAR_OK', JSON.stringify(newChapter));
    await page.locator('.sidebar').screenshot({ path: path.join(fixture, 'sidebar.png') });
    console.log('Sidebar buttons passed: 单行不溢出；截图 ' + fixture);
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
