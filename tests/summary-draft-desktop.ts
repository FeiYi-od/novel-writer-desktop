import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R07c-3 (摘要部分): an unsaved summary confirmation draft survives an exit and is not saved blindly.
async function main() {
  const fixture = path.resolve('.artifacts', `summary-draft-${Date.now()}`), folder = path.join(fixture, '摘要草稿小说');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const launch = async () => {
    const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
      env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
    const page = await app.firstWindow(); page.setDefaultTimeout(20000);
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    return { app, page };
  };
  const openMemories = async () => {
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '写作空间', exact: true }).click();
    await page.getByRole('button', { name: '记忆', exact: true }).click();
    await page.getByRole('button', { name: '打开章节摘要与故事记忆' }).click();
    await page.getByLabel('摘要确认稿').waitFor();
  };
  let page: import('playwright').Page; let app: Awaited<ReturnType<typeof launch>>['app'];
  ({ app, page } = await launch());
  try {
    await openMemories();
    await page.getByLabel('摘要确认稿').fill('第一章：林夏在雨夜推开北门，月钥发亮。');
    await page.waitForTimeout(1500);
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }

  ({ app, page } = await launch());
  try {
    await openMemories();
    await page.locator('.notice').filter({ hasText: '上次退出前有未保存的摘要确认稿' }).waitFor();
    await page.getByRole('button', { name: '恢复上次草稿', exact: true }).click();
    assert.equal(await page.getByLabel('摘要确认稿').inputValue(), '第一章：林夏在雨夜推开北门，月钥发亮。');
    await page.getByText('已恢复上次未保存的摘要确认稿，尚未确认保存', { exact: true }).waitFor();
    await page.locator('.notice').filter({ hasText: '上次退出前有未保存的摘要确认稿' }).waitFor({ state: 'detached' });
    console.log('Summary draft desktop passed: draft survived exit and was restored on request only.');
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
