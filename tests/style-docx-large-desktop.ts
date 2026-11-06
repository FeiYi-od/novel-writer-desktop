import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { encodeDocx } from '../src/main/docx';
import { textDocument } from '../src/main/text-import';

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/style-docx-large-desktop-'));
  const folder = path.join(fixture, '虚构合集'); await fs.mkdir(folder);
  const files: string[] = []; let total = 0;
  for (let i = 0; i < 1; i++) {
    const content = String(i) + '“虚构对白。”故事继续。'.repeat(300000); total += content.length;
    const file = path.join(fixture, `虚构参考${i}.docx`); await fs.writeFile(file, await encodeDocx(textDocument(content))); files.push(file);
  }
  assert.ok(total > 2_000_000 && total < 6_000_000);
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
    const original = await fs.readFile(files[0]!);
    const start = Date.now(); await page.getByRole('button', { name: '＋ 导入文本', exact: true }).click();
    const boxes = page.locator('.source-list input[type="checkbox"]'); await boxes.last().waitFor(); assert.equal(await boxes.count(), 1);
    for (let i = 0; i < 1; i++) await boxes.nth(i).check();
    await page.getByLabel('文风名称', { exact: true }).fill('单本全文'); await page.getByLabel('分析范围', { exact: true }).selectOption('full');
    await page.getByRole('button', { name: '分析并生成文风', exact: true }).click(); await page.getByText(/全文分段分析：覆盖/u).waitFor();
    const book = await page.evaluate(projectId => window.writer.readBook(projectId), id);
    assert.equal(book.value.sources.length, 1); assert.equal(book.value.styles[0]!.metrics.characters, total);
    assert.deepEqual(await fs.readFile(files[0]!), original, '导入不修改原件');
    const stored = path.join(folder, '小说资料', 'style-sources', book.value.sources[0]!.id + '.docx');
    assert.deepEqual(await fs.readFile(stored), original, '参考资料保留 DOCX 原字节');
    const malformed = Buffer.from(original), end = malformed.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    let cursor = malformed.readUInt32LE(end + 16); const count = malformed.readUInt16LE(end + 10); let changed = false;
    for (let i = 0; i < count; i++) {
      const len = malformed.readUInt16LE(cursor + 28), extra = malformed.readUInt16LE(cursor + 30), comment = malformed.readUInt16LE(cursor + 32);
      if (malformed.subarray(cursor + 46, cursor + 46 + len).toString('utf8') === 'word/document.xml') { malformed.writeUInt32LE(1, cursor + 24); changed = true; break; }
      cursor += 46 + len + extra + comment;
    }
    assert.equal(changed, true); const invalidFile = path.join(fixture, '畸形.docx'); await fs.writeFile(invalidFile, malformed);
    await app.evaluate(({dialog}, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, invalidFile);
    await page.getByRole('button', { name: '＋ 导入文本', exact: true }).click(); await page.getByRole('alert').filter({ hasText: /解压失败|实际内容|大小/ }).waitFor();
    assert.deepEqual(await fs.readFile(invalidFile), malformed); assert.deepEqual(await fs.readFile(stored), original);
    assert.equal((await page.evaluate(projectId => window.writer.readBook(projectId), id)).value.sources.length, 1, '畸形文件不得入库');
    const many: string[] = [];
    for (let index = 0; index < 4; index++) { const file = path.join(fixture, `超限${index}.txt`); await fs.writeFile(file, String(index) + '字'.repeat(2_100_000)); many.push(file); }
    await app.evaluate(({dialog}, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: selected }); }, many);
    await page.getByRole('button', { name: '＋ 导入文本', exact: true }).click(); await page.getByRole('alert').filter({ hasText: /800 万字符/ }).waitFor();
    assert.equal((await page.evaluate(projectId => window.writer.readBook(projectId), id)).value.sources.length, 1, '批量超限不得部分入库');
    const rss = await app.evaluate(() => process.memoryUsage().rss);
    console.log(JSON.stringify({ test: 'style-docx-large-desktop', inputCharacters: total, elapsedMs: Date.now() - start, mainRssMiB: Math.round(rss / 1048576), passed: true }));
  } finally { await app.evaluate(({app: instance}) => instance.exit(0)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
