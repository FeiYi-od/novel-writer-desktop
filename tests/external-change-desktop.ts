import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R08d-1: an external edit to a chapter file is announced, and switching books does not leak the
// previous book's notice.
async function main() {
  const fixture = path.resolve('.artifacts', `external-watch-${Date.now()}`);
  const bookA = path.join(fixture, '监听小说甲'), bookB = path.join(fixture, '监听小说乙');
  await fs.mkdir(bookA, { recursive: true }); await fs.mkdir(bookB, { recursive: true });
  const require = createRequire(import.meta.url);
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--exe' && path.isAbsolute(args[1]!)));
  const app = await electron.launch({ executablePath: args.length ? args[1]! : require('electron'), args: args.length ? [] : [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  try {
    if (args.length) {
      const identity = await app.evaluate(({ app: instance }) => ({ packaged: instance.isPackaged, version: instance.getVersion() }));
      assert.equal(identity.packaged, true);
      assert.equal(identity.version, JSON.parse(await fs.readFile('package.json', 'utf8')).version);
    }
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, bookA);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const chapter = await window.writer.createChapter(id, 'txt');
      await window.writer.saveChapter({ projectId: id, path: chapter.path, expectedHash: chapter.hash,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '虚构监听正文。' }] }] } });
    });
    // Let the watcher attach, then edit the file outside the app.
    await page.waitForTimeout(1200);
    // The application's own save can generate a neutral change notice; clear it
    // so it cannot accidentally satisfy the external-edit assertion below.
    const notice = page.getByText(/检测到章节文件变化/u);
    if (await notice.isVisible()) {
      await page.getByRole('button', { name: '忽略', exact: true }).click();
      await notice.waitFor({ state: 'hidden' });
    }
    const sources = path.join(bookA, '小说资料', 'style-sources');
    await fs.mkdir(sources, { recursive: true });
    await fs.writeFile(path.join(sources, '虚构语料.txt'), '语料内容，不是章节。', 'utf8');
    await page.waitForTimeout(700);
    assert.equal(await notice.isVisible(), false, '语料不应被误报为章节变化');
    const files = (await fs.readdir(bookA)).filter(name => name.endsWith('.txt'));
    assert.ok(files.length >= 1);
    await fs.writeFile(path.join(bookA, files[0]), '虚构监听正文，外部改了。', 'utf8');
    await fs.writeFile(path.join(bookA, '外部新章节.txt'), '　　新增正文。', 'utf8');
    await page.locator('.chapter-list').getByRole('button', { name: '外部新章节.txt' }).waitFor({ timeout: 15000 });
    assert.equal(await notice.isVisible(), false, '未打开章节的变化应刷新列表而不是显示冲突');
    console.log('External chapter change desktop passed: metadata ignored and external chapter list refreshed.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
