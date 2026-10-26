import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Workspace } from '../src/main/workspace';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function tree(root: string): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  const walk = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false);
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else { assert.equal(entry.isFile(), true); output[path.relative(root, file)] = digest(await fs.readFile(file)); }
    }
  };
  await walk(root); return output;
}
async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

async function main() {
  const args = process.argv.slice(2);
  assert.equal(args.length, 2, 'Usage: tsx tests/regex-packaged-desktop.ts --exe <absolute win-unpacked exe>');
  assert.equal(args[0], '--exe'); assert.ok(args[1] && path.isAbsolute(args[1]), '--exe must be explicit and absolute');
  const executable = path.resolve(args[1]), runtime = path.dirname(executable), archive = path.join(runtime, 'resources/app.asar');
  const executableStat = await fs.lstat(executable), archiveStat = await fs.lstat(archive);
  assert.ok(executableStat.isFile() && !executableStat.isSymbolicLink()); assert.ok(archiveStat.isFile() && !archiveStat.isSymbolicLink());
  const version = JSON.parse(await fs.readFile('package.json', 'utf8')).version as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/regex-packaged-desktop-042-'));
  const book = path.join(fixture, '虚构打包正则小说'); await fs.mkdir(book);
  const userData = path.join(fixture, 'profile'), materials = path.join(userData, '创作资料');
  const workspace = new Workspace(userData, materials); await workspace.initialize();
  const project = await workspace.attach(book); await workspace.readNotes(project.id);
  const chapter = await workspace.createChapter(project.id, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '\u3000\u3000虚构原稿与全角空格不应被正则预览改变。' }] }] });
  const manuscriptFile = path.join(book, chapter.path), manuscript = await fs.readFile(manuscriptFile);
  const normalFile = path.join(fixture, '正常脚本.json'), evilFile = path.join(fixture, '仅在线程执行的回溯脚本.json');
  const normalSource = Buffer.from('\uFEFF' + JSON.stringify({ id: randomUUID(), scriptName: '虚构打包单条规则', findRegex: '/cat/g', replaceString: '猫',
    placement: [2], futureExtension: { retained: true } }, null, 2).replace(/\n/gu, '\r\n') + '\r\n');
  await fs.writeFile(normalFile, normalSource);
  // Never instantiate or execute this expression in the test/main process.
  await fs.writeFile(evilFile, JSON.stringify([{ findRegex: '/(a+)+$/', replaceString: '不得返回部分结果' }]));
  const storedFile = path.join(book, '小说资料/正则脚本.json'), canonical = path.join(materials, project.id);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  let app: ElectronApplication | null = null; let page!: Page;
  const errors: string[] = [], checks: string[] = [];
  const modal = () => page.getByTestId('macro-panel');
  const launch = async () => {
    app = await electron.launch({ executablePath: executable, args: [], env: { ...env, NOVEL_WRITER_TEST_DATA: userData }, timeout: 30000 });
    const identity = await app.evaluate(({ app: instance }) => ({ packaged: instance.isPackaged, path: instance.getAppPath(), version: instance.getVersion() }));
    assert.equal(identity.packaged, true, 'This test must execute a real packaged app');
    assert.equal(path.relative(await fs.realpath(archive), await fs.realpath(identity.path)), '', 'Must execute the supplied app.asar');
    assert.equal(identity.version, version);
    page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  };
  const openBook = async () => {
    await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, book);
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByText(`已打开「${path.basename(book)}」`, { exact: false }).first().waitFor();
  };
  const openPanel = async () => {
    await page.getByTestId('macro-open').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="macro-panel"]')?.getAttribute('aria-busy') === 'false');
  };
  const importScripts = async (file: string) => {
    await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, file);
    await modal().getByTestId('macro-import').click();
    await modal().getByTestId('macro-message').filter({ hasText: '已导入' }).waitFor();
  };
  const normalPreview = async () => {
    await modal().getByLabel('宏角色名').fill('林夏'); await modal().getByLabel('宏测试文本').fill('{{char}} cat');
    await modal().getByTestId('macro-preview').click(); await modal().locator('.macro-result pre').nth(1).waitFor();
    assert.deepEqual(await modal().locator('.macro-result pre').allTextContents(), ['林夏 cat', '林夏 猫']);
  };
  const responsive = async () => {
    const projects = await bounded(page.evaluate(() => window.writer.listProjects()), 1500, 'Packaged main IPC was blocked by regex execution');
    assert.ok(projects.some(value => value.id === project.id));
    const ticks = await page.evaluate(() => (window as any).__packagedRegexTicks as number);
    await page.waitForFunction(previous => (window as any).__packagedRegexTicks >= previous + 2, ticks, { timeout: 1200 });
  };
  const closePanel = async () => { await modal().getByTestId('macro-close').click(); await modal().waitFor({ state: 'detached' }); };
  const exit = async () => {
    const closed = app!.waitForEvent('close', { timeout: 30000 });
    await page.getByRole('button', { name: '保存并退出', exact: true }).click(); await closed; app = null;
  };
  try {
    await launch(); await openBook(); await openPanel(); await importScripts(normalFile); await normalPreview();
    const sourceFile = await modal().getByTestId('macro-import-source').textContent(); assert.ok(sourceFile);
    assert.deepEqual(await fs.readFile(sourceFile), normalSource); assert.deepEqual(await fs.readFile(normalFile), normalSource);
    const sourceManifest = JSON.parse(await fs.readFile(path.join(path.dirname(sourceFile), 'manifest.json'), 'utf8'));
    assert.equal(sourceManifest.projectId, project.id); assert.equal(sourceManifest.kind, 'regex-import-source');
    assert.equal(sourceManifest.format, 'single'); assert.equal(sourceManifest.sha256, digest(normalSource));
    checks.push('Packaged single community JSON preserves exact BOM/CRLF/unknown source bytes and project-scoped source manifest');
    const normalRaw = await fs.readFile(storedFile), currentBefore = await tree(canonical);
    const requestId = randomUUID();
    const identityResult = await page.evaluate(async ({ id, request }) => window.writer.previewMacros(id, '{{char}} cat', { characterName: '林夏' }, request), { id: project.id, request: requestId });
    assert.equal(identityResult.schemaVersion, 1); assert.equal(identityResult.projectId, project.id); assert.equal(identityResult.requestId, requestId);
    assert.match(identityResult.sourceHash, /^[a-f0-9]{64}$/u); assert.equal(identityResult.expanded, '林夏 cat'); assert.equal(identityResult.applied, '林夏 猫');
    assert.deepEqual(await fs.readFile(storedFile), normalRaw); assert.deepEqual(await fs.readFile(manuscriptFile), manuscript);
    await page.screenshot({ path: path.join(fixture, 'packaged-regex-normal.png') });
    checks.push('isPackaged=true and supplied app.asar execute real macro/regex worker; explicit projectId/requestId/sourceHash match');

    await page.evaluate(() => { (window as any).__packagedRegexTicks = 0; setInterval(() => { (window as any).__packagedRegexTicks++; }, 25); });
    await importScripts(evilFile); const evilRaw = await fs.readFile(storedFile);
    await modal().getByLabel('宏测试文本').fill('a'.repeat(4000) + '!');
    const timeoutBegan = Date.now(); await modal().getByTestId('macro-preview').click(); await modal().getByTestId('macro-cancel').waitFor();
    assert.equal(await modal().locator('.macro-result').count(), 0); await responsive();
    await modal().getByTestId('macro-error').filter({ hasText: /超时|超过.*(?:秒|时限)|timeout/iu }).waitFor();
    assert.ok(Date.now() - timeoutBegan >= 1800); assert.ok(Date.now() - timeoutBegan < 8000);
    assert.equal(await modal().locator('.macro-result').count(), 0); assert.ok(await modal().getByTestId('macro-close').isEnabled());
    assert.deepEqual(await fs.readFile(storedFile), evilRaw); assert.deepEqual(await fs.readFile(manuscriptFile), manuscript);
    assert.deepEqual(await tree(canonical), currentBefore);
    await page.screenshot({ path: path.join(fixture, 'packaged-regex-timeout.png') });
    checks.push('Real catastrophic regex times out inside packaged worker while main IPC/renderer ticker respond; no partial result or source edits');

    // Observe the actual request ID without replacing the production handler logic.
    await app!.evaluate(({ ipcMain }) => {
      const channel = 'macros:preview', original = (ipcMain as any)._invokeHandlers.get(channel);
      if (!original) throw new Error('Missing production preview handler');
      (globalThis as any).__packagedRegexRequest = null;
      ipcMain.removeHandler(channel); ipcMain.handle(channel, (event, ...args) => {
        (globalThis as any).__packagedRegexRequest = { projectId: args[0], requestId: args[3] };
        return original(event, ...args);
      });
    });
    const cancelBegan = Date.now(); await modal().getByTestId('macro-preview').click(); await modal().getByTestId('macro-cancel').waitFor();
    await responsive();
    const observed = await app!.evaluate(() => (globalThis as any).__packagedRegexRequest as { projectId: string; requestId: string } | null);
    assert.ok(observed); assert.equal(observed.projectId, project.id); assert.match(observed.requestId, /^[a-f0-9-]{36}$/iu);
    await page.evaluate(id => {
      (window as any).__packagedSyncState = 'pending';
      void window.writer.materialSyncStatus(id).then(() => { (window as any).__packagedSyncState = 'done'; }, error => { (window as any).__packagedSyncState = String(error); });
    }, project.id);
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => (window as any).__packagedSyncState), 'pending', 'Exclusive material sync should queue behind the preview');
    assert.ok(await modal().getByTestId('macro-close').isDisabled());
    const exitError = await page.evaluate(async () => {
      try { const token = await window.writer.beginSaveExit(); await window.writer.cancelSaveExit(token); return ''; }
      catch (error) { return String(error); }
    });
    assert.match(exitError, /未完成|正在|等待/u);
    const cancelStart = Date.now(); await modal().getByTestId('macro-cancel').click();
    await modal().getByText('预览已取消，未应用任何结果。', { exact: true }).waitFor();
    assert.ok(Date.now() - cancelStart < 1500, 'Cancellation must bypass the queued exclusive gate');
    assert.ok(Date.now() - cancelBegan < 2800, 'Cancellation must finish before the default timeout');
    await page.waitForFunction(() => (window as any).__packagedSyncState === 'done', undefined, { timeout: 2000 });
    assert.equal(await modal().locator('.macro-result').count(), 0); assert.deepEqual(await fs.readFile(storedFile), evilRaw);
    assert.deepEqual(await tree(canonical), currentBefore); assert.deepEqual(await fs.readFile(manuscriptFile), manuscript);
    await page.screenshot({ path: path.join(fixture, 'packaged-regex-cancel.png') });
    checks.push('Packaged cancellation bypasses queued exclusive material sync, releases it promptly, and never changes manuscript/scripts/canonical');

    await importScripts(normalFile); await normalPreview();
    assert.deepEqual(await fs.readFile(sourceFile), normalSource); assert.deepEqual(await fs.readFile(normalFile), normalSource);
    assert.deepEqual(await fs.readFile(storedFile), normalRaw); assert.deepEqual(await tree(canonical), currentBefore);
    await closePanel(); await exit(); await launch(); await openBook(); await openPanel(); await normalPreview();
    assert.deepEqual(await fs.readFile(storedFile), normalRaw); assert.deepEqual(await fs.readFile(manuscriptFile), manuscript);
    await closePanel(); await page.locator('.chapter-list button').filter({ hasText: chapter.path }).click();
    await page.locator('.tiptap p').first().waitFor();
    assert.ok((await page.locator('.tiptap p').first().textContent())?.startsWith('\u3000\u3000'));
    await exit(); assert.deepEqual(errors, []);
    checks.push('Normal worker preview recovers after timeout/cancel and packaged save-exit/restart preserves DOCX bytes and literal U+3000');
    await fs.writeFile(path.join(fixture, 'result.json'), JSON.stringify({ schemaVersion: 1, passed: true, scope: 'packaged app.asar worker, isolated fictional TEST_DATA profile; not NSIS or upgrade', version, projectId: project.id, checks }, null, 2));
    console.log(`Regex packaged desktop passed. Evidence: ${fixture}`);
  } catch (error) {
    if (page && !page.isClosed()) {
      await bounded(page.screenshot({ path: path.join(fixture, 'failure.png') }), 3000, 'Failure screenshot timed out').catch(() => {});
      await bounded(page.locator('body').innerText(), 1500, 'Failure page timed out').then(text => fs.writeFile(path.join(fixture, 'failure-page.txt'), text)).catch(() => {});
    }
    throw error;
  } finally {
    const pending = app as ElectronApplication | null;
    if (pending) {
      try { await bounded(pending.evaluate(({ app: instance }) => instance.exit(0)), 3000, 'Owned test process did not exit'); }
      catch { pending.process().kill(); } // This exact child was created by this test; never kill by process name.
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
