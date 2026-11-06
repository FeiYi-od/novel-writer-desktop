import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R5：设定文件导入（TXT）→ 候选出现（本地解析，不联网）
async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/setting-file-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const settingFile = path.join(fixture, '设定.txt');
  await fs.writeFile(settingFile, '角色：林夏\n别名：夏夏\n性格：嘴硬心软。\n\n地点：雾港\n正文：终年大雾的海港城。\n关键词：雾港,码头', 'utf8');
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(30000);
    page.on('dialog', dialog => void dialog.accept());
    await page.evaluate(async parentDir => window.writer.createProject(parentDir, '设定文件书', true), parent);
    await page.reload();
    await page.getByRole('button', { name: '打开作品 设定文件书' }).click();
    await page.getByRole('button', { name: '角色库' }).click();
    await page.getByTestId('setting-extract-open').click();
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, settingFile);
    await page.getByTestId('setting-import-file').click();
    await page.waitForFunction(() => ((document.querySelector('[data-testid=setting-text]') as HTMLTextAreaElement | null)?.value ?? '').includes('林夏'), undefined, { timeout: 15000 });
    await page.getByText(/已读入 设定\.txt/u).first().waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '提取候选' }).click();
    await page.getByLabel('选择 林夏').waitFor({ timeout: 15000 });
    await page.getByRole('dialog', { name: '从文字设定提取' }).screenshot({ path: path.join(fixture, 'setting-file.png') });
    console.log(`Setting file desktop passed: 文件导入回填并提取候选；截图 ${path.join(fixture, 'setting-file.png')}`);
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
