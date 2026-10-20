import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R19-1: importing a SillyTavern world book and previewing triggered entries for the chapter.
async function main() {
  const fixture = path.resolve('.artifacts', `world-desktop-${Date.now()}`), folder = path.join(fixture, '世界书小说');
  await fs.mkdir(folder, { recursive: true });
  const worldFile = path.join(fixture, '北方世界.json');
  await fs.writeFile(worldFile, JSON.stringify({ name: '北方世界', entries: {
    '0': { key: ['北门'], content: '北门在雨夜关闭，守门人不收铜钱。', order: 5 },
    '1': { key: ['月钥'], content: '月钥只认林夏的血。', order: 9 },
    '2': { key: ['不会出现'], content: '这条不该被触发。', order: 1 }
  } }, null, 2), 'utf8');
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  const queue = [folder, worldFile];
  try {
    await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.shift() ?? ''] }); }, queue);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    const chapterPath = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const chapter = await window.writer.createChapter(id, 'docx');
      await window.writer.saveChapter({ projectId: id, path: chapter.path, expectedHash: chapter.hash,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '林夏走到北门，握紧月钥。' }] }] } });
      return chapter.path;
    });
    await page.getByRole('button', { name: '↻' }).click();
    await page.getByTestId('world-open').click();
    const dialog = page.getByRole('dialog', { name: '世界书' });
    await dialog.waitFor();
    await dialog.getByLabel('检查用文本').fill('林夏走到北门，握紧月钥。');
    await dialog.getByTestId('world-import').click();
    await dialog.getByText(/已导入「北方世界」/u).waitFor();
    await page.waitForFunction(() => { const el = document.querySelector('[data-testid="world-preview"]') as HTMLButtonElement | null; return !!el && !el.disabled; }, undefined, { timeout: 15000 });
    await page.click('[data-testid="world-preview"]');
    await dialog.getByText(/当前章节会触发 2 条/u).waitFor();
    const text = await dialog.innerText();
    assert.match(text, /北门在雨夜关闭/u);
    assert.match(text, /月钥只认林夏的血/u);
    assert.doesNotMatch(text, /这条不该被触发/u, '未命中的条目不应出现在预览里');
    console.log('World info desktop passed: imported book, triggered two of three entries for the chapter.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
