import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R27b-3: author-maintained facts/foreshadowing, persisted with 故事记忆 and reloaded.
async function main() {
  const fixture = path.resolve('.artifacts', `story-facts-desktop-${Date.now()}`), folder = path.join(fixture, '事实小说');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).click();
    await page.locator('.tiptap').fill('月钥只能开启北门。');
    await page.getByRole('button', { name: '保存 DOCX', exact: true }).click();
    await page.getByText('DOCX 已保存到所选文件夹', { exact: true }).waitFor();
    const projectId = (await page.evaluate(() => window.writer.listProjects()))[0].id;

    await page.getByRole('button', { name: '记忆', exact: true }).click();
    await page.getByRole('button', { name: '打开章节摘要与故事记忆' }).click();
    await page.getByText('尚无事实或伏笔。手工录入的内容视为作者确认，不需要再走摘要确认。', { exact: true }).waitFor();
    await page.getByLabel('事实类型').selectOption('foreshadow');
    await page.getByLabel('事实内容').fill('谁拿走了月钥');
    await page.getByRole('button', { name: '添加', exact: true }).click();
    await page.getByText('谁拿走了月钥', { exact: true }).waitFor();
    await page.getByRole('button', { name: '标记已解决', exact: true }).click();
    await page.getByText('重新打开', { exact: true }).waitFor();
    // Reload from disk: the facts live in the book's 故事记忆.md.
    await page.getByRole('button', { name: '刷新摘要来源与保存基准' }).click();
    await page.getByText('谁拿走了月钥', { exact: true }).waitFor();
    const story = await fs.readFile(path.join(fixture, 'app-data', '创作资料', projectId, '故事记忆.md'), 'utf8').catch(() => '');
    assert.match(story, /谁拿走了月钥/u);
    await page.getByRole('button', { name: '删除', exact: true }).click();
    await page.getByText('尚无事实或伏笔。手工录入的内容视为作者确认，不需要再走摘要确认。', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log('Story facts desktop passed: add/resolve/reload/delete, persisted in 故事记忆.md, no model calls.');
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
