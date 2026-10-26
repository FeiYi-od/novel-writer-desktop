import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Workspace } from '../src/main/workspace';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function tree(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(directory: string) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      assert.equal(item.isSymbolicLink(), false);
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await walk(file); else files[path.relative(root, file)] = digest(await fs.readFile(file));
    }
  }
  await walk(root); return files;
}

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/regex-isolation-desktop-042-'));
  const first = path.join(fixture, 'A/虚构同名宏小说'), second = path.join(fixture, 'B/虚构同名宏小说');
  await fs.mkdir(first, { recursive: true }); await fs.mkdir(second, { recursive: true });
  const userData = path.join(fixture, 'profile'), materials = path.join(userData, '创作资料');
  const workspace = new Workspace(userData, materials); await workspace.initialize();
  const project = await workspace.attach(first), other = await workspace.attach(second);
  const chapter = await workspace.createChapter(project.id, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '\u3000\u3000虚构原稿不会因正则预览而改变。' }] }] });
  const manuscript = await fs.readFile(path.join(first, chapter.path));
  const normalFile = path.join(fixture, '正常脚本.json'), evilFile = path.join(fixture, '回溯脚本.json'), expansionFile = path.join(fixture, '输出上限脚本.json');
  const normal = [{ findRegex: '/cat/gi', replaceString: '猫' }, { findRegex: '/\\[(.*?)\\]/g', replaceString: '$1' }];
  await fs.writeFile(normalFile, JSON.stringify(normal));
  // These are data fixtures only. The catastrophic expression is executed solely by the worker.
  await fs.writeFile(evilFile, JSON.stringify([{ findRegex: '/(a+)+$/', replaceString: '不会成功的替换' }]));
  await fs.writeFile(expansionFile, JSON.stringify([{ findRegex: '/(?:)/g', replaceString: '大'.repeat(32768) }]));
  const scriptPath = path.join(first, '小说资料/正则脚本.json'), canonical = path.join(materials, project.id);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null; let page!: Page;
  const errors: string[] = [], checks: string[] = [];
  const launch = async () => {
    app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [path.resolve('out/main/index.js')], env: { ...env, NOVEL_WRITER_TEST_DATA: userData } });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  };
  const openBook = async (folder = first) => {
    await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByText(`已打开「${path.basename(folder)}」`, { exact: false }).first().waitFor();
  };
  const modal = () => page.getByTestId('macro-panel');
  const openPanel = async () => { await page.getByTestId('macro-open').click(); await modal().getByTestId('macro-close').waitFor({ state: 'visible' }); await page.waitForFunction(() => document.querySelector('[data-testid="macro-panel"]')?.getAttribute('aria-busy') === 'false'); };
  const importScripts = async (file: string) => {
    await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, file);
    await modal().getByTestId('macro-import').click(); await modal().getByTestId('macro-message').filter({ hasText: '已导入' }).waitFor();
  };
  const fill = async (text: string) => { await modal().getByLabel('宏测试文本').fill(text); };
  const start = async () => { await modal().getByTestId('macro-preview').click(); await modal().getByTestId('macro-cancel').waitFor(); };
  const expectNormal = async () => {
    await modal().getByLabel('宏角色名').fill('林岚'); await fill('{{char}} [cat] CAT');
    await modal().getByTestId('macro-preview').click(); await modal().locator('.macro-result pre').nth(1).waitFor();
    assert.deepEqual(await modal().locator('.macro-result pre').allTextContents(), ['林岚 [cat] CAT', '林岚 猫 猫']);
  };
  const responsive = async () => {
    const began = Date.now();
    const projects = await page.evaluate(() => window.writer.listProjects());
    assert.ok(projects.some(value => value.id === project.id)); assert.ok(Date.now() - began < 1500, '主进程IPC不能被正则回溯阻塞');
    const ticks = await page.evaluate(() => (window as any).__regexTicks ?? 0);
    await page.waitForFunction(previous => (window as any).__regexTicks >= previous + 2, ticks, { timeout: 1000 });
  };
  const closePanel = async () => { await modal().getByTestId('macro-close').click(); await modal().waitFor({ state: 'detached' }); };
  const exit = async () => { const closed = app!.waitForEvent('close', { timeout: 30000 }); await page.getByRole('button', { name: '保存并退出', exact: true }).click(); await closed; app = null; };
  try {
    await launch(); await openBook(); await openPanel(); await importScripts(normalFile); await expectNormal();
    const normalRaw = await fs.readFile(scriptPath), canonicalBefore = await tree(canonical);
    assert.deepEqual(await fs.readFile(path.join(first, chapter.path)), manuscript);
    await modal().focus(); await page.keyboard.press('Shift+Tab');
    assert.equal(await modal().getByTestId('macro-close').evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Tab'); assert.equal(await modal().getByTestId('macro-import').evaluate(element => element === document.activeElement), true);
    checks.push('既有宏/捕获替换语义、只读原稿和脚本、焦点循环');

    const exitGuard = await page.evaluate(async id => {
      const token = await window.writer.beginSaveExit();
      try {
        let previewError = '', importError = '';
        try { await window.writer.previewMacros(id, 'cat', {}, crypto.randomUUID()); } catch (error) { previewError = String(error); }
        try { await window.writer.importMacroScripts(id); } catch (error) { importError = String(error); }
        const cancelled = await window.writer.cancelMacroPreview(id, crypto.randomUUID());
        return { previewError, importError, cancelled };
      } finally { await window.writer.cancelSaveExit(token); }
    }, project.id);
    assert.match(exitGuard.previewError, /正在保存退出/); assert.match(exitGuard.importError, /正在保存退出/);
    assert.equal(exitGuard.cancelled, false);
    checks.push('退出会话拒绝新预览和导入，纯内存取消入口仍可达');

    await app!.evaluate(({ dialog }) => {
      (globalThis as any).__regexImport = {};
      dialog.showOpenDialog = async () => new Promise<{ canceled: boolean; filePaths: string[] }>(resolve => { (globalThis as any).__regexImport.resolve = resolve; });
    });
    await modal().getByTestId('macro-import').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="macro-panel"]')?.getAttribute('aria-busy') === 'true');
    assert.ok(await modal().getByTestId('macro-close').isDisabled()); assert.equal(await modal().getByTestId('macro-cancel').count(), 0);
    await page.keyboard.press('Escape'); assert.ok(await modal().isVisible());
    assert.equal(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true }))), false);
    await app!.evaluate(() => (globalThis as any).__regexImport.resolve({ canceled: true, filePaths: [] }));
    await modal().getByText('已取消导入，原脚本保持不变。', { exact: true }).waitFor();
    assert.deepEqual(await fs.readFile(scriptPath), normalRaw);
    checks.push('原生导入忙期保护，取消保留原脚本');

    await importScripts(evilFile); const evilRaw = await fs.readFile(scriptPath);
    await fill('a'.repeat(2000) + '!');
    await page.evaluate(() => { (window as any).__regexTicks = 0; (window as any).__regexTimer = window.setInterval(() => (window as any).__regexTicks++, 20); });
    await start(); const cancelBegan = Date.now();
    assert.equal(await modal().locator('.macro-result').count(), 0);
    assert.ok(await modal().getByTestId('macro-close').isDisabled()); assert.ok(await modal().getByTestId('macro-preview').isDisabled());
    await responsive(); await page.keyboard.press('Escape'); assert.ok(await modal().isVisible());
    await modal().focus(); await page.keyboard.press('Tab'); assert.equal(await modal().getByTestId('macro-cancel').evaluate(element => element === document.activeElement), true);
    assert.equal(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true }))), false);
    const exitError = await page.evaluate(async () => {
      try { const token = await window.writer.beginSaveExit(); await window.writer.cancelSaveExit(token); return ''; }
      catch (error) { return String(error); }
    });
    assert.match(exitError, /未完成|正在|等待/u);
    await page.screenshot({ path: path.join(fixture, 'regex-cancel-busy.png') });
    await modal().getByTestId('macro-cancel').click(); await modal().getByText('预览已取消，未应用任何结果。', { exact: true }).waitFor();
    assert.ok(Date.now() - cancelBegan < 2800, '取消应终止worker，不能等到默认超时');
    assert.equal(await modal().locator('.macro-result').count(), 0); assert.ok(await modal().getByTestId('macro-preview').isEnabled());
    assert.deepEqual(await fs.readFile(scriptPath), evilRaw); assert.deepEqual(await tree(canonical), canonicalBefore);
    checks.push('真实灾难回溯仅worker执行，IPC与界面保持响应，关闭/退出/重复受控，实际取消提前终止且不输出部分结果');

    const timeoutBegan = Date.now(); await start(); await responsive();
    await modal().getByTestId('macro-error').filter({ hasText: /超时|超过.*(?:秒|时限)|timeout/iu }).waitFor();
    assert.ok(Date.now() - timeoutBegan >= 1800); assert.ok(Date.now() - timeoutBegan < 8000);
    assert.equal(await modal().locator('.macro-result').count(), 0); assert.ok(await modal().getByTestId('macro-close').isEnabled());
    assert.deepEqual(await fs.readFile(scriptPath), evilRaw); assert.deepEqual(await fs.readFile(path.join(first, chapter.path)), manuscript);
    await page.screenshot({ path: path.join(fixture, 'regex-timeout.png') });
    checks.push('真实worker超时不挂主进程、不保留旧成功或部分结果、槽位可再次使用');

    await importScripts(expansionFile); const expandedRaw = await fs.readFile(scriptPath); await fill('a'.repeat(100)); await modal().getByTestId('macro-preview').click();
    await modal().getByTestId('macro-error').waitFor(); assert.equal(await modal().locator('.macro-result').count(), 0);
    assert.deepEqual(await fs.readFile(scriptPath), expandedRaw);
    await importScripts(normalFile); await expectNormal();
    assert.deepEqual(await fs.readFile(scriptPath), normalRaw);
    checks.push('输出膨胀被拒绝，失败后正常预览恢复，输入和持久化脚本不被预览改写');

    // An explicit cancellation also discards a late success whose worker has already finished.
    await app!.evaluate(({ ipcMain }) => {
      const channel = 'macros:preview', original = (ipcMain as any)._invokeHandlers.get(channel);
      (globalThis as any).__regexPreviewOriginal = original; (globalThis as any).__regexPreviewReady = false;
      ipcMain.removeHandler(channel); ipcMain.handle(channel, async (event, ...args) => {
        const result = await original(event, ...args); (globalThis as any).__regexPreviewReady = true;
        await new Promise(resolve => setTimeout(resolve, 700)); return result;
      });
    });
    await start();
    await page.waitForFunction(async () => (await window.writer.listProjects()).length > 0);
    for (let count = 0; count < 30 && !await app!.evaluate(() => (globalThis as any).__regexPreviewReady); count++) await page.waitForTimeout(20);
    assert.equal(await app!.evaluate(() => (globalThis as any).__regexPreviewReady), true);
    await modal().getByTestId('macro-cancel').click(); await modal().getByText('预览已取消，未应用任何结果。', { exact: true }).waitFor();
    assert.equal(await modal().locator('.macro-result').count(), 0);
    await app!.evaluate(({ ipcMain }) => { ipcMain.removeHandler('macros:preview'); ipcMain.handle('macros:preview', (globalThis as any).__regexPreviewOriginal); });
    await expectNormal(); await page.screenshot({ path: path.join(fixture, 'regex-recovery.png') });
    checks.push('取消与已完成响应竞态不显示迟到成功，之后正常请求不受旧取消影响');

    await closePanel(); await openBook(second); await openPanel();
    await modal().getByText('当前 0 条脚本', { exact: true }).waitFor(); await fill('cat [cat]');
    await modal().getByTestId('macro-preview').click(); await modal().locator('.macro-result pre').nth(1).waitFor();
    assert.deepEqual(await modal().locator('.macro-result pre').allTextContents(), ['cat [cat]', 'cat [cat]']);
    await assert.rejects(fs.access(path.join(second, '小说资料/正则脚本.json'))); assert.deepEqual(await fs.readFile(scriptPath), normalRaw);
    await closePanel(); await exit(); await launch(); await openBook(); await openPanel(); await expectNormal();
    assert.deepEqual(await fs.readFile(scriptPath), normalRaw); assert.deepEqual(await fs.readFile(path.join(first, chapter.path)), manuscript);
    await closePanel(); await page.locator('.chapter-list button').filter({ hasText: chapter.path }).click();
    assert.ok((await page.locator('.tiptap p').first().textContent())?.startsWith('\u3000\u3000'));
    await exit(); assert.deepEqual(errors, []);
    checks.push('同名双书脚本及请求隔离、保存退出重开、DOCX原字节与真实全角空格保留');
    await fs.writeFile(path.join(fixture, 'result.json'), JSON.stringify({ schemaVersion: 1, passed: true, projectId: project.id, otherProjectId: other.id, checks }, null, 2));
    console.log(`Regex isolation desktop passed. Evidence: ${fixture}`);
  } catch (error) {
    if (page && !page.isClosed()) { await page.screenshot({ path: path.join(fixture, 'failure.png') }).catch(() => {}); await fs.writeFile(path.join(fixture, 'failure-page.txt'), await page.locator('body').innerText().catch(() => '')).catch(() => {}); }
    throw error;
  } finally { const pending = app as ElectronApplication | null; if (pending) await pending.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
