import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  const fixture = path.resolve('.artifacts', `knowledge-selection-desktop-${Date.now()}`);
  const bookA = path.join(fixture, '来源筛选甲'), bookB = path.join(fixture, '来源筛选乙');
  const data = path.join(fixture, 'app-data');
  await Promise.all([fs.mkdir(bookA, { recursive: true }), fs.mkdir(bookB, { recursive: true })]);
  const names = Array.from({ length: 501 }, (_, i) => `第${String(i + 1).padStart(3, '0')}章.txt`);
  await Promise.all(names.map((name, i) => fs.writeFile(path.join(bookA, name), `书甲星桥的虚构第${i + 1}章。`, 'utf8')));
  const oversized = path.join(bookA, '未选超大原件.txt');
  await fs.writeFile(oversized, Buffer.alloc(8 * 1024 * 1024 + 1, 65));
  await fs.writeFile(path.join(bookB, names[0]), '书乙灯塔的同名虚构章节。', 'utf8');
  const before = await Promise.all([fs.readFile(path.join(bookA, names[0])), fs.readFile(path.join(bookA, names[1])), fs.readFile(oversized)]);
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: data } });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const choose = (folder: string) => app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
  const open = async (folder: string) => { await choose(folder); await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click(); await page.getByText(`已打开「${path.basename(folder)}」`, { exact: false }).waitFor(); };
  const enter = () => page.getByRole('button', { name: '知识检索', exact: true }).click();
  const release = () => app.evaluate(() => { const state = globalThis as any; state.__selectionHold = false; for (const resolve of state.__selectionHeld.splice(0)) resolve(); });
  const waitHeld = async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { if (await app.evaluate(() => (globalThis as any).__selectionHeld.length > 0)) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('Catalog response was not held');
  };
  const ready = () => page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>('button')].some(button => button.textContent === '重新读取来源' && !button.disabled));
  const reload = async () => { await page.getByRole('button', { name: '重新读取来源', exact: true }).click(); await ready(); };
  const search = async () => { await page.getByRole('button', { name: '检索本书', exact: true }).click(); await page.getByRole('status').filter({ hasText: '检索完成' }).waitFor(); return page.locator('.knowledge-hit').allTextContents(); };
  try {
    await app.evaluate(({ ipcMain }) => {
      const state = globalThis as any; state.__selectionHold = false; state.__selectionHeld = []; state.__selectionRequests = []; state.__selectionNetwork = 0;
      for (const channel of ['knowledge:sources', 'knowledge:search']) {
        const original = (ipcMain as any)._invokeHandlers.get(channel);
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (event, ...args) => {
          if (channel === 'knowledge:search') state.__selectionRequests.push(args[0]);
          const result = await original(event, ...args);
          if (channel === 'knowledge:sources' && state.__selectionHold) await new Promise<void>(resolve => state.__selectionHeld.push(resolve));
          return result;
        });
      }
      globalThis.fetch = (async () => { state.__selectionNetwork++; throw new Error('Synthetic selection test cannot call a model'); }) as typeof fetch;
    });
    await open(bookA);
    const projectA = (await page.evaluate(() => window.writer.listProjects())).find(project => project.root === bookA)!;
    const volumeId = await page.evaluate(async ({ id, chapters }) => {
      const snapshot = await window.writer.readBook(id); const volumeId = crypto.randomUUID();
      await window.writer.saveBook(id, { ...snapshot.value, volumes: [{ id: volumeId, title: '虚构第一卷', introduction: '', cover: '', chapters }] }, snapshot.hash);
      return volumeId;
    }, { id: projectA.id, chapters: names.slice(0, 2) });
    await enter(); await reload();
    await page.getByLabel('关键词', { exact: true }).fill('书甲星桥');
    assert.equal(await page.getByRole('button', { name: '检索本书', exact: true }).isEnabled(), false, 'More than 500 entries must not silently select the first 500');
    // 页面上还有一个「使用重排」复选框，统计源文本复选框时要扣掉它。
    assert.equal((await page.getByRole('checkbox').count()) - 1, 50, 'Loaded catalog is paginated');
    assert.equal(await app.evaluate(() => (globalThis as any).__selectionRequests.length), 0, 'Catalog loading must not search');
    await page.getByLabel('检索分卷', { exact: true }).selectOption(volumeId);
    const first = page.getByRole('checkbox', { name: `正文文稿 · ${names[0]}`, exact: true });
    const second = page.getByRole('checkbox', { name: `正文文稿 · ${names[1]}`, exact: true });
    assert.equal(await first.isChecked(), true); assert.equal(await second.isChecked(), true);
    assert.equal((await search()).length, 2);
    await first.uncheck(); assert.equal(await page.locator('.knowledge-hit').count(), 0);
    const one = await search(); assert.equal(one.length, 1); assert.match(one[0], new RegExp(names[1].replace('.', '\\.')));
    const frozen = await app.evaluate(() => (globalThis as any).__selectionRequests.at(-1));
    assert.deepEqual(frozen.sourcePaths, [`chapters:${names[1]}`]); assert.match(frozen.catalogHash, /^[a-f0-9]{64}$/); assert.equal(frozen.projectId, projectA.id);
    // Structural changes invalidate the catalog before a selected original is read.
    await page.evaluate(async id => { const snapshot = await window.writer.readBook(id); await window.writer.saveBook(id, { ...snapshot.value, volumes: snapshot.value.volumes.map(volume => ({ ...volume, title: '虚构卷已改名' })) }, snapshot.hash); }, projectA.id);
    await page.getByRole('button', { name: '检索本书', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /来源|目录/ }).first().waitFor();
    assert.equal(await page.locator('.knowledge-hit').count(), 0);
    await reload(); await page.getByLabel('检索分卷', { exact: true }).selectOption(volumeId);
    assert.equal((await search()).length, 2);
    await page.getByLabel('检索分卷', { exact: true }).selectOption('');
    assert.equal(await page.getByRole('button', { name: '检索本书', exact: true }).isEnabled(), false);

    // A held metadata reply protects save/exit and cannot attach to another purpose.
    await app.evaluate(() => { (globalThis as any).__selectionHold = true; });
    await page.getByRole('button', { name: '重新读取来源', exact: true }).click(); await waitHeld();
    await page.getByRole('button', { name: '保存并退出', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '正在处理' }).first().waitFor(); assert.equal(app.process().exitCode, null);
    await page.getByLabel('检索范围', { exact: true }).selectOption('canon');
    await release();
    await page.getByRole('button', { name: '重新读取来源', exact: true }).click();
    await ready();
    assert.equal(await page.getByLabel('检索范围', { exact: true }).inputValue(), 'canon');
    await page.getByLabel('关键词', { exact: true }).fill('书甲星桥');
    assert.equal(await page.getByRole('button', { name: '检索本书', exact: true }).isEnabled(), false, 'Draft chapters are not canon sources');
    await page.getByRole('button', { name: '写作空间', exact: true }).click();
    await open(bookB); await enter();
    await page.getByLabel('关键词', { exact: true }).fill('书乙灯塔');
    const other = await search(); assert.equal(other.length, 1); assert.match(other[0], /书乙灯塔/); assert.doesNotMatch(other[0], /书甲星桥/);
    const projectB = (await page.evaluate(() => window.writer.listProjects())).find(project => project.root === bookB)!;
    assert.equal((await app.evaluate(() => (globalThis as any).__selectionRequests.at(-1))).projectId, projectB.id);
    for (const [i, file] of [path.join(bookA, names[0]), path.join(bookA, names[1]), oversized].entries()) assert.deepEqual(await fs.readFile(file), before[i]);
    assert.equal(await app.evaluate(() => (globalThis as any).__selectionNetwork), 0); assert.deepEqual(errors, []);
    await page.getByRole('button', { name: '写作空间', exact: true }).click();
    await page.getByRole('button', { name: '来源筛选甲 独立小说空间' }).click(); await enter();
    await page.getByLabel('检索分卷', { exact: true }).selectOption(volumeId); await page.getByLabel('关键词', { exact: true }).fill('书甲星桥'); await search();
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
    await fs.writeFile(path.resolve('.artifacts/knowledge-selection.png'), Buffer.from(png, 'base64'));
    console.log('Knowledge selection desktop passed: 502-entry metadata catalog, bounded paging, explicit volume/subset, untouched oversized unselected original, structural stale rejection/reload, purpose/book isolation, frozen request and metadata save/exit guard; no model/network.');
  } finally { await release().catch(() => {}); await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
