import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/style-single-large-desktop-'));
  const folder = path.join(fixture, '虚构合集'); await fs.mkdir(folder);
  const files: string[] = []; let total = 0;
  for (let i = 0; i < 1; i++) {
    const content = String(i) + '“虚构对白。”故事继续。'.repeat(458333); total += content.length;
    const file = path.join(fixture, `虚构参考${i}.txt`); await fs.writeFile(file, content); files.push(file);
  }
  assert.ok(total > 5_000_000 && total < 6_000_000);
  const args = process.argv.slice(2); assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--exe' && path.isAbsolute(args[1]!)));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: args.length ? args[1]! : createRequire(import.meta.url)('electron'), args: args.length ? [] : [path.resolve('out/main/index.js')], env });
  try {
    if (args.length) { const info = await app.evaluate(({app}) => ({ packaged: app.isPackaged, version: app.getVersion() })); assert.equal(info.packaged, true); assert.equal(info.version, JSON.parse(await fs.readFile('package.json', 'utf8')).version); }
    const page = await app.firstWindow(); page.setDefaultTimeout(60000);
    await app.evaluate(({dialog}, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click(); await page.getByText('已打开「虚构合集」', { exact: false }).waitFor();
    const id = (await page.evaluate(() => window.writer.listProjects()))[0]!.id;
    await page.getByRole('button', { name: '文风研习室', exact: true }).click();
    await app.evaluate(({dialog}, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: selected }); }, files);
    const start = Date.now(); await page.getByRole('button', { name: '＋ 导入文本', exact: true }).click();
    const boxes = page.locator('.source-list input[type="checkbox"]'); await boxes.last().waitFor(); assert.equal(await boxes.count(), 1);
    for (let i = 0; i < 1; i++) await boxes.nth(i).check();
    await page.getByLabel('文风名称', { exact: true }).fill('单本全文'); await page.getByLabel('分析范围', { exact: true }).selectOption('full');
    await page.getByRole('button', { name: '分析并生成文风', exact: true }).click(); await page.getByText(/全文分段分析：覆盖/u).waitFor();
    const book = await page.evaluate(projectId => window.writer.readBook(projectId), id);
    assert.equal(book.value.sources.length, 1); assert.equal(book.value.styles[0]!.metrics.characters, total);
    const rss = await app.evaluate(() => process.memoryUsage().rss);
    console.log(JSON.stringify({ test: 'style-single-large-desktop', inputCharacters: total, elapsedMs: Date.now() - start, mainRssMiB: Math.round(rss / 1048576), passed: true }));
  } finally { await app.evaluate(({app: instance}) => instance.exit(0)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
