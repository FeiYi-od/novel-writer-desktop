import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R2：合并文风在界面上显示每份来源的贡献百分比（本地统计，不联网）
async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/style-weights-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const sources = path.join(fixture, '语料'); await fs.mkdir(sources);
  const longFile = path.join(sources, '长篇.txt'); const shortFile = path.join(sources, '短篇.txt');
  await fs.writeFile(longFile, '　　长篇叙述，句子较长，描写细密。'.repeat(400), 'utf8');
  await fs.writeFile(shortFile, '　　“短句对白。”他说。'.repeat(400), 'utf8');
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  const override = async (filePath: string) => app!.evaluate(({ dialog }, value) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [value] }); }, filePath);
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(30000);
    page.on('dialog', dialog => void dialog.accept());
    const projectId = await page.evaluate(async parentDir => (await window.writer.createProject(parentDir, '权重书', false)).project.id, parent);
    await page.reload();
    await page.getByRole('button', { name: '打开作品 权重书' }).click();
    await page.getByRole('button', { name: '文风研习室' }).click();
    for (const file of [longFile, shortFile]) {
      await override(file);
      await page.getByRole('button', { name: '＋ 导入文本' }).click();
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(1500);
    const imported = await page.evaluate(async id => (await window.writer.readBook(id)).value.sources.length, projectId);
    assert.ok(imported >= 2, '应导入两份语料，实际 ' + imported);
    await page.evaluate(async id => {
      let book = await window.writer.readBook(id);
      book = await window.writer.analyzeStyle(id, '长篇权重', [book.value.sources[0]!.id], book.hash, { mode: 'sample' });
      book = await window.writer.analyzeStyle(id, '短篇权重', [book.value.sources[1]!.id], book.hash, { mode: 'sample' });
      const styleIds = book.value.styles.map(style => style.id);
      book = await window.writer.mergeStyles(id, '合并权重', styleIds, 'characters', book.hash);
      await window.writer.saveBook(id, { ...book.value, activeStyleId: book.value.styles.at(-1)!.id }, book.hash);
    }, projectId);
    await page.reload();
    await page.getByRole('button', { name: '打开作品 权重书' }).click();
    await page.getByRole('button', { name: '文风研习室' }).click();
    const weights = page.getByTestId('style-weights');
    await weights.waitFor({ timeout: 20000 });
    const text = await weights.innerText();
    assert.match(text, /长篇权重\s*\d+%/u);
    assert.match(text, /短篇权重\s*\d+%/u);
    assert.ok((await weights.locator('progress').count()) >= 2, '每份来源应有进度条');
    await page.screenshot({ path: path.join(fixture, 'weights.png') });
    console.log(`Style weights desktop passed: 合并档案显示来源与百分比；截图 ${path.join(fixture, 'weights.png')}`);
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
