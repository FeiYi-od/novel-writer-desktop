import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R1：全文分段分析（本地统计，不联网）真实界面流程
async function main() {
  const args = process.argv.slice(2); assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--exe' && path.isAbsolute(args[1]!)));
  const executable = args.length ? args[1]! : createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/style-fulltext-desktop-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const sources = path.join(fixture, '语料'); await fs.mkdir(sources);
  const long = Array.from({ length: 800 }, (_, index) => index % 4 === 0 ? `“第${index}句对白。”他说。` : `第${index}段叙述，用来撑长文本并保持句式变化，包含补充说明与细节描写。`).join('\n');
  const file = path.join(sources, '长篇.txt'); await fs.writeFile(file, long, 'utf8');
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  try {
    app = await electron.launch({ executablePath: executable, args: args.length ? [] : [path.resolve('out/main/index.js')], env });
    if (args.length) { const info = await app.evaluate(({app}) => ({ packaged: app.isPackaged, version: app.getVersion() })); assert.equal(info.packaged, true); assert.equal(info.version, JSON.parse(await fs.readFile('package.json', 'utf8')).version); }
    page = await app.firstWindow(); page.setDefaultTimeout(25000);
    page.on('dialog', dialog => void dialog.accept());
    const projectId = await page.evaluate(async parentDir => (await window.writer.createProject(parentDir, '全文分析书', true)).project.id, parent);
    await page.reload();
    await page.getByRole('button', { name: '打开作品 全文分析书' }).click();
    await page.getByRole('button', { name: '文风研习室' }).click();
    await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, file);
    await page.getByRole('button', { name: '＋ 导入文本' }).click();
    await page.locator('.source-list label').first().waitFor({ timeout: 20000 });
    await page.getByRole('checkbox').first().check();
    await page.getByLabel('文风名称', { exact: true }).fill('全文档案');
    await page.getByLabel('分析范围', { exact: true }).selectOption('full');
    await page.getByRole('button', { name: '分析并生成文风' }).click();
    await page.locator('.style-card').first().waitFor({ timeout: 30000 });
    await page.getByText(/全文分段分析：覆盖/u).waitFor({ timeout: 15000 });
    const saved = await page.evaluate(async id => (await window.writer.readBook(id)).value.styles[0], projectId);
    assert.equal(saved?.coverage?.mode, 'full');
    assert.ok((saved?.coverage?.characters ?? 0) > 10000, `覆盖字符应超过一万，实际 ${saved?.coverage?.characters}`);
    assert.ok((saved?.coverage?.chunks ?? 0) > 1, '应分成多段');
    assert.equal(saved?.coverage?.characters, long.replace(/\s/g, '').length, '全文计数覆盖到短尾');
    await page.getByLabel('文风名称', { exact: true }).fill('快速档案');
    await page.getByLabel('分析范围', { exact: true }).selectOption('sample');
    await page.getByRole('button', { name: '分析并生成文风' }).click();
    await page.getByText(/本地快速统计：/u).waitFor();
    const sampled = await page.evaluate(async id => (await window.writer.readBook(id)).value.styles.find(style => style.name === '快速档案'), projectId);
    assert.equal(sampled?.coverage?.mode, 'sample'); assert.ok((sampled?.metrics.characters ?? 0) < (saved?.metrics.characters ?? 0));
    console.log('Style full-text desktop passed: 全文分段分析覆盖整本并在界面显示覆盖范围，未联网。');
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
