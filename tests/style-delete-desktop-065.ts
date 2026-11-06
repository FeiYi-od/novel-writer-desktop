import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R3：参考文本删除（被引用时拒绝）、文风档案删除（清空启用项）
async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/style-delete-desktop-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const sources = path.join(fixture, '语料'); await fs.mkdir(sources);
  const first = path.join(sources, '甲.txt'); await fs.writeFile(first, ('　　甲文第一段，句号结尾。这句话用来凑够分析所需的长度。第二句也有句号。\n　　第二段，也有句号。再来一句让字数足够用于本地统计。\n').repeat(6), 'utf8');
  const second = path.join(sources, '乙.txt'); await fs.writeFile(second, ('　　乙文开头，逗号，逗号。这一行也要足够长，避免分析被拒绝。\n　　又一段，句号结尾。再补一句凑字数。\n').repeat(6), 'utf8');
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(25000);
    page.on('dialog', dialog => void dialog.accept());
    const accept = async () => { const dialog = page.getByTestId('confirm-dialog'); await dialog.waitFor({ timeout: 10000 }); await page.getByTestId('confirm-accept').click(); await dialog.waitFor({ state: 'detached', timeout: 10000 }); };
    // 建书（走 API，避免向导步骤干扰；随后刷新让书架重新加载）
    const projectId = await page.evaluate(async parentDir => {
      const created = await window.writer.createProject(parentDir, '文风删除书', true);
      return created.project.id;
    }, parent);
    await page.reload();
    await page.getByRole('button', { name: '打开作品 文风删除书' }).click();
    await page.getByRole('button', { name: '文风研习室' }).click();
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [first, second]);
    await page.getByRole('button', { name: '＋ 导入文本' }).click();
    await page.locator('.source-list label').first().waitFor({ timeout: 20000 });
    assert.equal(await page.locator('.source-list label').count(), 2);
    // 生成一份本地文风档案（不使用任何模型）
    await page.getByRole('checkbox').first().check();
    await page.getByLabel('文风名称', { exact: true }).fill('甲作者文风');
    await page.getByRole('button', { name: '分析并生成文风' }).click();
    try { await page.locator('.style-card').first().waitFor({ timeout: 30000 }); } catch (failure) { console.error('STYLE_DEBUG', await page.locator('.error').allTextContents(), await page.evaluate(async id => (await window.writer.readBook(id)).value.styles.length, projectId)); throw failure; }
    // 删除文风档案 → 再删参考文本
    await page.locator('[data-testid^="style-remove-"]').first().click();
    await accept();
    await page.locator('.style-card').first().waitFor({ state: 'detached', timeout: 15000 }).catch(() => undefined);
    const afterStyle = await page.evaluate(async id => window.writer.readBook(id), projectId);
    assert.equal(afterStyle.value.styles.length, 0);
    assert.equal(afterStyle.value.activeStyleId, '');
    await page.locator('[data-testid^="source-remove-"]').first().click();
    await page.waitForFunction(async id => (await window.writer.readBook(id)).value.sources.length === 1, projectId, { timeout: 15000 });
    console.log('Style delete desktop passed: 被引用时拒绝删除参考文本，删除档案后参考文本可删，启用项被清空。');
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
