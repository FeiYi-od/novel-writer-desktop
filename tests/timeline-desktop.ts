import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R23-2: the timeline panel saves events ordered by the author's own time labels.
async function main() {
  const fixture = path.resolve('.artifacts', `timeline-desktop-${Date.now()}`), folder = path.join(fixture, '时间线小说');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    await page.getByRole('button', { name: '故事时间线…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '故事时间线' });
    await dialog.waitFor();
    const add = async (when: string, title: string) => {
      await dialog.getByLabel('时间点').fill(when);
      await dialog.getByLabel('事件标题').fill(title);
      await dialog.getByRole('button', { name: '添加到时间线', exact: true }).click();
    };
    await add('第10天', '抵达北门');
    await add('第2天', '离开村庄');
    await dialog.getByRole('button', { name: '保存时间线', exact: true }).click();
    await page.getByText('时间线已保存', { exact: true }).waitFor();
    const entries = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      return (await window.writer.readTimeline(id)).entries.map(entry => `${entry.when}|${entry.title}`);
    });
    assert.deepEqual(entries, ['第2天|离开村庄', '第10天|抵达北门'], '时间线应按数值顺序保存');
    const file = await fs.readdir(path.join(fixture, '创作资料'));
    assert.ok(file.some(name => name.startsWith('时间线-')), '时间线应保存为本书资料');
    console.log('Timeline desktop passed: entries saved in numeric order as project material.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
