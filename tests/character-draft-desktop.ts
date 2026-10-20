import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R07c-2 (角色编辑部分): an unsaved character edit survives an exit and is not written to the library.
async function main() {
  const fixture = path.resolve('.artifacts', `character-draft-${Date.now()}`), folder = path.join(fixture, '角色草稿小说');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const launch = async () => {
    const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
      env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
    const page = await app.firstWindow(); page.setDefaultTimeout(20000);
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    return { app, page };
  };
  const openLibrary = async () => { await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click(); await page.getByRole('button', { name: '角色库', exact: true }).first().click(); await page.getByRole('button', { name: '＋ 新建文字角色卡', exact: true }).waitFor(); };
  let page: import('playwright').Page; let app: Awaited<ReturnType<typeof launch>>['app'];
  ({ app, page } = await launch());
  try {
    await openLibrary();
    await page.getByRole('button', { name: '＋ 新建文字角色卡', exact: true }).click();
    await page.getByLabel('角色名称').fill('林夏');
    await page.waitForTimeout(1500);
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }

  ({ app, page } = await launch());
  try {
    await openLibrary();
    await page.getByText('已恢复上次未保存的角色编辑，保存后才会写入角色库。', { exact: false }).waitFor();
    assert.equal(await page.getByLabel('角色名称').inputValue(), '林夏');
    const cards = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      return (await window.writer.readCharacters(id)).value.cards.length;
    });
    assert.equal(cards, 0, '未保存的角色编辑绝不能写入角色库');
    await page.getByRole('button', { name: '放弃这次编辑', exact: true }).click();
    await page.getByText('已恢复上次未保存的角色编辑，保存后才会写入角色库。', { exact: false }).waitFor({ state: 'detached' });
    console.log('Character draft desktop passed: edit survived exit, nothing was written to the library, discard cleared it.');
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
