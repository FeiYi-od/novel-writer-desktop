import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { encodeDocx } from '../src/main/docx';
import { textDocument } from '../src/main/text-import';

async function main() {
  const fixture = path.resolve('.artifacts', `chapter-confirmation-desktop-${Date.now()}`);
  const bookA = path.join(fixture, '确认学园甲'), bookB = path.join(fixture, '确认海港乙'), data = path.join(fixture, 'app-data');
  await Promise.all([fs.mkdir(bookA, { recursive: true }), fs.mkdir(bookB, { recursive: true })]);
  const name = '同名正文.docx', candidate = '未确认候选.txt';
  const originalA = await encodeDocx(textDocument('甲书银叶钟楼只在旧版出现。')), originalB = await encodeDocx(textDocument('乙书蓝鲸海港禁止混入甲书。'));
  await fs.writeFile(path.join(bookA, name), originalA); await fs.writeFile(path.join(bookB, name), originalB);
  await fs.writeFile(path.join(bookA, candidate), '草稿石鸥尚未作者确认。', 'utf8');
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: data } });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const choose = (folder: string) => app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
  const open = async (folder: string) => { await choose(folder); await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click(); await page.getByText(`已打开「${path.basename(folder)}」`, { exact: false }).waitFor(); };
  const enter = async () => { await page.getByRole('button', { name: '正文版本确认', exact: true }).click(); await ready(); };
  const ready = () => page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>('button')].some(button => button.textContent === '重新读取确认记录' && !button.disabled));
  const refresh = async () => { await page.getByRole('button', { name: '重新读取确认记录', exact: true }).click(); await ready(); };
  const check = () => page.getByRole('checkbox', { name: '我已核对整个正文版本，确认作为本书故事事实', exact: true });
  const preview = async (source = name) => { await page.getByLabel('确认正文章节', { exact: true }).selectOption(source); await page.getByRole('button', { name: '读取待确认版本', exact: true }).click(); await page.locator('.confirmation-preview').waitFor(); await ready(); };
  const accept = async () => { await check().check(); await page.getByRole('button', { name: '确认此正文版本', exact: true }).click(); await ready(); };
  const release = () => app.evaluate(() => { const state = globalThis as any; state.__confirmationHold = false; for (const resolve of state.__confirmationHeld.splice(0)) resolve(); });
  const waitHeld = async () => { const deadline = Date.now() + 5000; while (Date.now() < deadline) { if (await app.evaluate(() => (globalThis as any).__confirmationHeld.length)) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('Preview reply was not held'); };
  const canonSearch = async (query: string) => {
    await page.getByText('更多功能', { exact: true }).click(); await page.getByRole('button', { name: '知识检索', exact: true }).click();
    await page.getByLabel('检索范围', { exact: true }).selectOption('canon');
    await page.getByRole('button', { name: '重新读取来源', exact: true }).click();
    await page.getByLabel('关键词', { exact: true }).fill(query);
    await page.getByRole('button', { name: '检索本书', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '检索完成' }).waitFor();
    return page.locator('.knowledge-hit').allTextContents();
  };
  try {
    await app.evaluate(({ ipcMain }) => {
      const state = globalThis as any; state.__confirmationHold = false; state.__confirmationHeld = []; state.__confirmationNetwork = 0; state.__confirmationRequests = [];
      for (const channel of ['confirmation:preview', 'confirmation:confirm']) {
        const original = (ipcMain as any)._invokeHandlers.get(channel); ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (event, ...args) => {
          if (channel === 'confirmation:confirm') state.__confirmationRequests.push(args[0]);
          const result = await original(event, ...args);
          if (channel === 'confirmation:preview' && state.__confirmationHold) await new Promise<void>(resolve => state.__confirmationHeld.push(resolve));
          return result;
        });
      }
      globalThis.fetch = (async () => { state.__confirmationNetwork++; throw new Error('Confirmation test cannot call a model'); }) as typeof fetch;
    });
    await open(bookA);
    const projectA = (await page.evaluate(() => window.writer.listProjects())).find(project => project.root === bookA)!;
    await page.evaluate(async id => { const snapshot = await window.writer.readNotes(id); await window.writer.saveNotes(id, { ...snapshot.value, world: '甲书世界规则仅作测试。' }, snapshot.hash); }, projectA.id);
    assert.deepEqual(await canonSearch('银叶钟楼'), [], 'Saving a chapter cannot confirm canon');
    await page.getByRole('button', { name: '写作空间', exact: true }).click(); await enter();
    assert.equal((await page.evaluate(id => window.writer.chapterConfirmations(id), projectA.id)).value.entries.length, 0);
    assert.equal(await page.getByRole('button', { name: '确认此正文版本', exact: true }).isEnabled(), false);
    await preview(); assert.match(await page.locator('.confirmation-preview').textContent() ?? '', /银叶钟楼/);
    assert.equal(await page.getByRole('button', { name: '确认此正文版本', exact: true }).isEnabled(), false);
    await accept(); let snapshot = await page.evaluate(id => window.writer.chapterConfirmations(id), projectA.id);
    assert.equal(snapshot.value.entries.length, 1); const firstId = snapshot.value.entries[0].id;
    assert.equal(snapshot.value.entries[0].enabled, true); assert.deepEqual(snapshot.staleIds, []);
    assert.deepEqual(await fs.readFile(path.join(bookA, name)), originalA);
    assert.match((await canonSearch('银叶钟楼')).join('\n'), /银叶钟楼/);
    assert.deepEqual(await canonSearch('草稿石鸥'), []);
    // Changing bytes invalidates the old confirmation without deleting its record.
    const changed = await encodeDocx(textDocument('甲书新版白色廊桥由作者核对。'));
    await fs.writeFile(path.join(bookA, name), changed);
    assert.deepEqual(await canonSearch('银叶钟楼'), []); assert.deepEqual(await canonSearch('白色廊桥'), []);
    await page.getByRole('button', { name: '写作空间', exact: true }).click(); await enter();
    snapshot = await page.evaluate(id => window.writer.chapterConfirmations(id), projectA.id);
    assert.ok(snapshot.staleIds.includes(firstId)); assert.match(await page.locator(`.confirmation-entry[data-id="${firstId}"]`).textContent() ?? '', /失效/);
    await preview(); await accept(); snapshot = await page.evaluate(id => window.writer.chapterConfirmations(id), projectA.id);
    assert.equal(snapshot.value.entries.length, 2); assert.equal(snapshot.value.entries.find(entry => entry.id === firstId)?.enabled, false);
    const active = snapshot.value.entries.find(entry => entry.enabled)!;
    assert.match((await canonSearch('白色廊桥')).join('\n'), /白色廊桥/);
    await page.getByRole('button', { name: '写作空间', exact: true }).click(); await enter();
    await page.getByRole('button', { name: `停用确认 ${active.id}`, exact: true }).click(); await ready();
    assert.deepEqual(await canonSearch('白色廊桥'), []);
    // A preview is frozen: an external edit before accepting it is rejected.
    await page.getByRole('button', { name: '写作空间', exact: true }).click(); await enter(); await preview();
    const latest = await encodeDocx(textDocument('甲书第三版紫色窗台。')); await fs.writeFile(path.join(bookA, name), latest);
    await check().check(); await page.getByRole('button', { name: '确认此正文版本', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /变化|更新/ }).first().waitFor();
    assert.equal((await page.evaluate(id => window.writer.chapterConfirmations(id), projectA.id)).value.entries.filter(entry => entry.enabled).length, 0);
    await refresh(); await preview(); await accept();
    assert.deepEqual(await fs.readFile(path.join(bookA, name)), latest);

    // Hidden-page preview cannot prevent an explicit book switch or attach to its new project.
    await app.evaluate(() => { (globalThis as any).__confirmationHold = true; }); await previewStart(); await waitHeld();
    await page.getByRole('button', { name: '保存并退出', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '正在处理' }).first().waitFor(); assert.equal(app.process().exitCode, null);
    await page.getByRole('button', { name: '写作空间', exact: true }).click(); await open(bookB); await release(); await enter();
    assert.equal(await page.locator('.confirmation-preview').count(), 0);
    const projectB = (await page.evaluate(() => window.writer.listProjects())).find(project => project.root === bookB)!;
    assert.equal((await page.evaluate(id => window.writer.chapterConfirmations(id), projectB.id)).value.entries.length, 0);
    await preview(); assert.match(await page.locator('.confirmation-preview').textContent() ?? '', /蓝鲸海港/); assert.doesNotMatch(await page.locator('.confirmation-preview').textContent() ?? '', /紫色窗台/);
    await accept(); assert.equal((await app.evaluate(() => (globalThis as any).__confirmationRequests.at(-1))).projectId, projectB.id);
    assert.deepEqual(await fs.readFile(path.join(bookB, name)), originalB);
    // Unsaved editor content blocks confirming the saved disk version.
    await page.getByRole('button', { name: '写作空间', exact: true }).click(); await page.getByRole('button', { name: '＋ 新建 DOCX 章节', exact: true }).click();
    await page.locator('.tiptap').fill('尚未保存的作者正文不应确认旧磁盘稿。'); await enter(); await preview(name);
    assert.equal(await check().isEnabled(), false); assert.equal(await page.getByRole('button', { name: '确认此正文版本', exact: true }).isEnabled(), false);
    assert.equal(await app.evaluate(() => (globalThis as any).__confirmationNetwork), 0); assert.deepEqual(errors, []);
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
    await fs.writeFile(path.resolve('.artifacts/chapter-confirmations.png'), Buffer.from(png, 'base64'));
    console.log('Chapter confirmation desktop passed: explicit preview/checkbox, unchanged DOCX originals, canon inclusion only for current author-confirmed bytes, old version invalidation/history/reconfirmation/revoke, external conflict, delayed preview book isolation, save/exit busy and unsaved editor block; no model/network.');
    async function previewStart() { await page.getByLabel('确认正文章节', { exact: true }).selectOption(name); await page.getByRole('button', { name: '读取待确认版本', exact: true }).click(); }
  } finally { await release().catch(() => {}); await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
