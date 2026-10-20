import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R07c-1: unsaved planning input survives an exit and is only restored when the author asks.
async function main() {
  const fixture = path.resolve('.artifacts', `planning-draft-${Date.now()}`), folder = path.join(fixture, '筹备草稿小说');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const launch = async () => {
    const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
      env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
    const page = await app.firstWindow(); page.setDefaultTimeout(20000);
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    return { app, page };
  };
  const openBook = async () => { await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click(); await page.getByRole('button', { name: '创作筹备', exact: true }).click(); await page.getByLabel('筹备构想').waitFor(); };
  let page: import('playwright').Page; let app: Awaited<ReturnType<typeof launch>>['app'];
  ({ app, page } = await launch());
  try {
    await openBook();
    await page.getByLabel('筹备构想').fill('雨夜章节需要一条暗线：月钥只能开启北门。');
    await page.waitForTimeout(1500); // debounce save of the draft
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }

  ({ app, page } = await launch());
  try {
    await openBook();
    const banner = page.locator('.notice').filter({ hasText: '上次退出前有未保存的筹备草稿' });
    await banner.waitFor();
    await page.getByRole('button', { name: '恢复上次草稿', exact: true }).click();
    assert.equal(await page.getByLabel('筹备构想').inputValue(), '雨夜章节需要一条暗线：月钥只能开启北门。', '恢复后内容必须与退出前一致');
    await page.getByText('已恢复上次未保存的筹备草稿，尚未保存到资料', { exact: true }).waitFor();
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }

  ({ app, page } = await launch());
  try {
    await openBook();
    // Still unsaved: the draft must be offered again, and discarding it removes the offer for good.
    await page.locator('.notice').filter({ hasText: '上次退出前有未保存的筹备草稿' }).waitFor();
    await page.getByRole('button', { name: '丢弃草稿', exact: true }).click();
    await page.locator('.notice').filter({ hasText: '上次退出前有未保存的筹备草稿' }).waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '保存筹备资料', exact: true }).click().catch(() => {});
    console.log('Planning draft desktop passed: draft persisted across exit, restored only on request, discard removes it.');
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
