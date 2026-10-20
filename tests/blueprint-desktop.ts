import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R23-1: a chapter blueprint is saved, and becomes stale once the chapter text changes.
async function main() {
  const fixture = path.resolve('.artifacts', `blueprint-desktop-${Date.now()}`), folder = path.join(fixture, '蓝图小说');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  const clickEnabled = async (selector: string) => {
    await page.waitForFunction(sel => { const el = document.querySelector(sel) as HTMLButtonElement | null; return !!el && !el.disabled; }, selector, { timeout: 15000 });
    await page.click(selector);
  };
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    const chapterPath = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const chapter = await window.writer.createChapter(id, 'docx');
      await window.writer.saveChapter({ projectId: id, path: chapter.path, expectedHash: chapter.hash,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '写着雨的北门。' }] }] } });
      return chapter.path;
    });
    await page.getByRole('button', { name: '↻' }).click();
    await page.getByRole('button', { name: '分卷与章节蓝图…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '蓝图' });
    await dialog.waitFor();
    await dialog.getByLabel('蓝图对象').selectOption(chapterPath);
    await dialog.getByLabel('蓝图标题').fill('北门之夜');
    await dialog.getByLabel('蓝图目标').fill('推进第一次冲突');
    await dialog.getByLabel('蓝图情节点').fill('林夏抵达北门\n月钥发光');
    await clickEnabled('[data-testid="blueprint-upsert"]');
    await clickEnabled('[data-testid="blueprint-save"]');
    await dialog.getByText('蓝图已保存', { exact: true }).waitFor();
    const saved = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const snapshot = await window.writer.readBlueprints(id);
      return { count: snapshot.nodes.length, beats: snapshot.nodes[0].beats.length, stale: snapshot.stale.length };
    });
    assert.deepEqual(saved, { count: 1, beats: 2, stale: 0 });
    // Change the chapter text, then reopen the panel: the plan must be flagged as stale.
    await page.evaluate(async path => {
      const id = (await window.writer.listProjects())[0].id;
      const current = await window.writer.readChapter(id, path);
      await window.writer.saveChapter({ projectId: id, path, expectedHash: current.hash,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '改写后的北门。' }] }] } });
    }, chapterPath);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '分卷与章节蓝图…', exact: true }).click();
    const reopened = page.getByRole('dialog', { name: '蓝图' });
    await reopened.waitFor();
    await reopened.getByText('来源已变化，建议复核', { exact: false }).waitFor();
    console.log('Blueprint desktop passed: saved with beats, stale flag appears after the chapter changed.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
