import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R07c-2 (资料转换部分): unsaved conversion input survives an exit and is only restored on request.
async function main() {
  const fixture = path.resolve('.artifacts', `materials-draft-${Date.now()}`), folder = path.join(fixture, '资料草稿小说');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const launch = async () => {
    const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
      env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
    const page = await app.firstWindow(); page.setDefaultTimeout(20000);
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    return { app, page };
  };
  const openMaterials = async () => {
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '资料转换', exact: true }).click();
    await page.getByLabel('转换原文').waitFor();
  };
  let page: import('playwright').Page; let app: Awaited<ReturnType<typeof launch>>['app'];
  ({ app, page } = await launch());
  try {
    await openMaterials();
    await page.getByLabel('转换原文').fill('林夏：月钥只能开启北门。');
    await page.getByRole('button', { name: '套用模板（不调用 AI）', exact: true }).click();
    await page.waitForTimeout(1500);
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }

  ({ app, page } = await launch());
  try {
    await openMaterials();
    await page.locator('.notice').filter({ hasText: '上次退出前有未保存的资料转换草稿' }).waitFor();
    await page.getByRole('button', { name: '恢复上次草稿', exact: true }).click();
    assert.equal(await page.getByLabel('转换原文').inputValue(), '林夏：月钥只能开启北门。');
    await page.getByText('已恢复上次未保存的资料转换草稿，尚未确认保存', { exact: true }).waitFor();
    const files = await fs.readdir(path.join(folder, '创作资料')).catch(() => [] as string[]);
    assert.ok(!files.some(name => name.includes('人物卡')), '恢复草稿不能写入创作资料');
    await page.getByRole('button', { name: '丢弃草稿', exact: true }).click().catch(() => {});
    console.log('Materials draft desktop passed: conversion input survived exit, restored on request only, nothing written to materials.');
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
