import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { Workspace } from '../src/main/workspace';
import { MaterialSyncService } from '../src/main/material-sync';
import { CharacterStore } from '../src/main/characters';
import { LibraryStore } from '../src/main/library';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function tree(root: string) {
  const output: Record<string, string> = {};
  async function walk(directory: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false);
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else { assert.ok(entry.isFile()); output[path.relative(root, file)] = digest(await fs.readFile(file)); }
    }
  }
  await walk(root); return output;
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--exe' && path.isAbsolute(args[1]!)), 'Usage: tsx tests/material-retention-desktop.ts [--exe <absolute packaged exe>]');
  const executable = args.length ? path.resolve(args[1]!) : createRequire(import.meta.url)('electron') as string;
  const expectedVersion = JSON.parse(await fs.readFile('package.json', 'utf8')).version as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/material-retention-058-'));
  const book = path.join(fixture, 'A/虚构同名书'), otherBook = path.join(fixture, 'B/虚构同名书');
  await fs.mkdir(book, { recursive: true }); await fs.mkdir(otherBook, { recursive: true });
  const userData = path.join(fixture, 'profile'), materials = path.join(userData, '创作资料');
  const workspace = new Workspace(userData, materials); await workspace.initialize();
  const project = await workspace.attach(book), other = await workspace.attach(otherBook);
  for (const id of [project.id, other.id]) await workspace.readNotes(id);
  const characters = new CharacterStore(id => workspace.getProject(id), materials), library = new LibraryStore(id => workspace.getProject(id), materials);
  for (const id of [project.id, other.id]) { await characters.read(id); await library.read(id); }
  const service = new MaterialSyncService(workspace, materials, userData); await service.configure(project.id, false); await service.configure(other.id, false);
  const chapter = await workspace.createChapter(project.id, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '\u3000\u3000虚构正文保持原样。' }] }] });
  const manuscript = await fs.readFile(path.join(book, chapter.path));
  const historyId = randomUUID(), otherId = randomUUID(), localRoot = path.join(materials, '同步历史', project.id);
  const oldFolder = path.join(localRoot, historyId), otherFolder = path.join(localRoot, otherId);
  await fs.mkdir(oldFolder, { recursive: true }); await fs.mkdir(otherFolder, { recursive: true });
  await fs.writeFile(path.join(oldFolder, '旧设定.txt'), '虚构旧设定：原文件持续保留。');
  await fs.writeFile(path.join(otherFolder, '另一旧设定.txt'), '虚构另一份历史，保留活动位置。');
  const secondBookHistory = path.join(materials, '同步历史', other.id, historyId);
  await fs.mkdir(secondBookHistory, { recursive: true }); await fs.writeFile(path.join(secondBookHistory, '同名书资料.txt'), '另一本书的历史独立保留。');
  const secondBookBefore = await tree(secondBookHistory);
  const localBefore = await tree(oldFolder), otherBefore = await tree(otherFolder);
  const stateFile = path.join(userData, 'material-sync', `${project.id}.json`), stateBefore = await fs.readFile(stateFile);
  const canonical = path.join(materials, project.id); let canonicalBefore = await tree(canonical);
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = userData; delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  const errors: string[] = [];
  const history = () => page.getByTestId('history-panel'), outer = () => page.getByTestId('material-sync-panel');
  const select = async () => {
    await history().locator(`[data-testid="history-version"][data-id="${historyId}"]`).click();
    await history().locator('[data-testid="history-file"][data-path="旧设定.txt"]').waitFor();
  };
  const settled = () => page.waitForFunction(() => document.querySelector('[data-testid="history-panel"]')?.getAttribute('aria-busy') === 'false');
  const openHistory = async () => {
    await page.getByTestId('material-sync-open').click(); await outer().locator('.material-sync-history summary').click(); await outer().getByTestId('history-open').click();
    await history().waitFor(); await settled();
  };
  try {
    app = await electron.launch({ executablePath: executable, args: args.length ? [] : [path.resolve('out/main/index.js')], env });
    if (args.length) {
      const identity = await app.evaluate(({ app: instance }) => ({ packaged: instance.isPackaged, version: instance.getVersion() }));
      assert.equal(identity.packaged, true); assert.equal(identity.version, expectedVersion);
    }
    page = await app.firstWindow(); page.setDefaultTimeout(25000); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, book);
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click(); await page.getByText(`已打开「${path.basename(book)}」`, { exact: false }).first().waitFor();
    await openHistory();
    assert.equal(await history().getByTestId('history-capacity-local').getAttribute('data-level'), 'normal');
    await history().getByTestId('history-capacity-local').getByText('2', { exact: true }).waitFor();
    assert.equal(await history().getByTestId('history-retain').isDisabled(), true);
    await select();
    assert.equal(await history().locator(`[data-testid="history-version"][data-id="${historyId}"]`).getAttribute('data-location'), 'active');
    assert.equal(await history().getByTestId('history-retain').isEnabled(), true);
    // Confirmation cancellation never invokes the handler and leaves all files in place.
    page.once('dialog', dialog => { assert.match(dialog.message(), /不释放磁盘空间|旧版应用/u); void dialog.dismiss(); });
    await history().getByTestId('history-retain').click();
    assert.deepEqual(await tree(oldFolder), localBefore);
    assert.equal(await history().getByTestId('history-retain').isEnabled(), true);

    // An unsaved worldbuilding draft prevents the operation and stays in the editor.
    await history().getByTestId('history-close').click(); await outer().getByTestId('material-sync-close').click();
    await page.getByRole('button', { name: '世界观', exact: true }).click();
    const note = page.locator('#project-note'), savedNote = await note.inputValue(); await note.fill('虚构未保存草稿，必须原样留窗。');
    await openHistory(); await select();
    page.once('dialog', dialog => void dialog.accept()); await history().getByTestId('history-retain').click();
    await history().getByTestId('history-error').filter({ hasText: '请先保存' }).waitFor();
    assert.deepEqual(await tree(oldFolder), localBefore);
    await history().getByTestId('history-close').click(); await outer().getByTestId('material-sync-close').click();
    assert.equal(await note.inputValue(), '虚构未保存草稿，必须原样留窗。');
    await note.fill(savedNote); await page.getByRole('button', { name: '保存本书资料', exact: true }).click();
    await page.getByText('本书资料已保存', { exact: true }).waitFor(); canonicalBefore = await tree(canonical); await openHistory(); await select();

    // A forged response cannot be applied, even if it looks like a successful operation.
    await app.evaluate(({ ipcMain }) => {
      const state = globalThis as any, channel = 'materials-sync:history-retain';
      state.__retentionOriginal = (ipcMain as any)._invokeHandlers.get(channel); ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (_event, request) => ({ schemaVersion: 1, projectId: '00000000-0000-4000-8000-000000000000', id: request.id, location: 'retained', files: 1, bytes: 1 }));
    });
    page.once('dialog', dialog => void dialog.accept()); await history().getByTestId('history-retain').click();
    await history().getByTestId('history-error').filter({ hasText: '不匹配' }).waitFor();
    assert.equal(await history().getByTestId('history-retain').isDisabled(), true);
    assert.deepEqual(await tree(oldFolder), localBefore);
    await app.evaluate(({ ipcMain }) => { const state = globalThis as any, channel = 'materials-sync:history-retain'; ipcMain.removeHandler(channel); ipcMain.handle(channel, state.__retentionOriginal); });
    await history().getByTestId('history-refresh').click(); await settled(); await select();

    // Any unfinished synchronization journal blocks the move, even if malformed.
    const pendingFile = path.join(userData, 'material-sync', `${project.id}-pending.json`);
    await fs.writeFile(pendingFile, '{虚构未完成同步记录', { flag: 'wx' });
    page.once('dialog', dialog => void dialog.accept()); await history().getByTestId('history-retain').click();
    await history().getByTestId('history-error').waitFor();
    assert.ok(await history().isVisible()); assert.deepEqual(await tree(oldFolder), localBefore);
    assert.equal(await history().getByTestId('history-retain').isDisabled(), true);
    assert.equal(await history().getByTestId('history-version').count(), 0, '操作发出后失败需刷新才能再次选择，不能保留可能过期的活动行');
    assert.equal(await fs.readFile(pendingFile, 'utf8'), '{虚构未完成同步记录');
    await fs.unlink(pendingFile);
    await history().getByTestId('history-refresh').click(); await settled(); await select();

    // Delay the actual IPC to inspect close, focus and save/exit while in flight.
    await app.evaluate(({ ipcMain }) => {
      const state = globalThis as any, channel = 'materials-sync:history-retain'; ipcMain.removeHandler(channel);
      state.__retentionRelease = undefined;
      ipcMain.handle(channel, async (event, ...args) => {
        await new Promise<void>(resolve => { state.__retentionRelease = resolve; });
        return state.__retentionOriginal(event, ...args);
      });
    });
    page.once('dialog', dialog => void dialog.accept()); await history().getByTestId('history-retain').click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="history-close"]') as HTMLButtonElement)?.disabled === true);
    await page.waitForFunction(() => (document.querySelector('button.save-exit') as HTMLButtonElement)?.disabled === true);
    assert.equal(await page.getByRole('button', { name: '保存并退出', exact: true }).isDisabled(), true);
    assert.equal(await outer().evaluate(element => Boolean(element.closest('[inert]'))), true);
    await history().focus(); await page.keyboard.press('Escape'); assert.equal(await history().count(), 1);
    assert.equal(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true }))), false);
    await app.evaluate(async () => {
      const state = globalThis as any;
      for (let index = 0; index < 200 && typeof state.__retentionRelease !== 'function'; index++) await new Promise(resolve => setTimeout(resolve, 10));
      if (typeof state.__retentionRelease !== 'function') throw new Error('保留请求未到达控制的IPC');
      state.__retentionRelease(); state.__retentionRelease = undefined;
    });
    await history().getByText(/已移至保留区，释放一个活动历史名额/u).waitFor(); await settled();
    assert.equal(await history().locator(`[data-testid="history-version"][data-id="${historyId}"]`).getAttribute('data-location'), 'retained');
    await history().getByTestId('history-capacity-local').getByText('1', { exact: true }).waitFor();
    await history().getByTestId('history-retained-count').filter({ hasText: /本机保留区：1/u }).waitFor();
    await page.screenshot({ path: path.join(fixture, 'retained.png') });
    const retained = path.join(materials, '同步历史保留', project.id, historyId);
    assert.deepEqual(await tree(retained), localBefore); await assert.rejects(fs.access(oldFolder)); assert.deepEqual(await tree(otherFolder), otherBefore);
    assert.deepEqual(await tree(canonical), canonicalBefore); assert.deepEqual(await fs.readFile(stateFile), stateBefore); assert.deepEqual(await fs.readFile(path.join(book, chapter.path)), manuscript);
    await select(); assert.equal(await history().getByTestId('history-retain').isDisabled(), true, '保留区不可重复移动');
    await history().locator('[data-testid="history-file"][data-path="旧设定.txt"]').click();
    await history().locator('.material-history-side pre').filter({ hasText: '虚构旧设定' }).waitFor();
    await history().getByTestId('history-copy').click(); await history().getByTestId('history-result').waitFor();
    const copyPath = await history().getByTestId('history-result').locator('code').textContent(); assert.ok(copyPath);
    assert.deepEqual(await tree(path.join(copyPath!, 'files')), localBefore);
    await history().getByTestId('history-dag-open').click();
    const dag = page.getByTestId('history-dag-panel'); await dag.waitFor();
    await dag.getByTestId('history-dag-preview').waitFor(); await dag.getByTestId('history-dag-confirm').click();
    const dagResult = dag.getByTestId('history-dag-result'); await dagResult.waitFor();
    const zipPath = await dagResult.locator('code').first().textContent(); assert.ok(zipPath);
    const zip = await JSZip.loadAsync(await fs.readFile(zipPath!)); const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    assert.ok(manifest.local.some((entry: { id: string }) => entry.id === historyId), '完整DAG必须包含保留区版本');
    assert.deepEqual(await tree(retained), localBefore); assert.deepEqual(await fs.readFile(path.join(book, chapter.path)), manuscript);
    await dag.getByTestId('history-dag-close').click(); await history().getByTestId('history-close').click(); await outer().getByTestId('material-sync-close').click();
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, otherBook);
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByText(`已打开「${path.basename(otherBook)}」· 0 个正文文件`, { exact: false }).first().waitFor();
    await openHistory();
    assert.equal(await history().locator(`[data-testid="history-version"][data-id="${historyId}"]`).getAttribute('data-location'), 'active');
    await history().getByTestId('history-retained-count').filter({ hasText: /本机保留区：0/u }).waitFor();
    assert.deepEqual(await tree(secondBookHistory), secondBookBefore);
    assert.deepEqual(errors, []);
    console.log(`Material retention desktop passed: ${fixture}`);
  } finally { if (app) await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
