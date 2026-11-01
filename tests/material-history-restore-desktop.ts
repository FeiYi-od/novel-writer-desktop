import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Workspace } from '../src/main/workspace';
import { MaterialSyncService } from '../src/main/material-sync';
import { CharacterStore } from '../src/main/characters';
import { LibraryStore } from '../src/main/library';

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--exe' && path.isAbsolute(args[1]!)), 'Usage: tsx tests/material-history-restore-desktop.ts [--exe <absolute packaged exe>]');
  const executable = args.length ? path.resolve(args[1]!) : createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/material-restore-desktop-059-'));
  const book = path.join(fixture, 'A/虚构同名书'), otherBook = path.join(fixture, 'B/虚构同名书');
  await fs.mkdir(book, { recursive: true }); await fs.mkdir(otherBook, { recursive: true });
  const userData = path.join(fixture, 'profile'), materials = path.join(userData, '创作资料');
  const workspace = new Workspace(userData, materials); await workspace.initialize();
  const project = await workspace.attach(book), other = await workspace.attach(otherBook);
  const characters = new CharacterStore(id => workspace.getProject(id), materials), library = new LibraryStore(id => workspace.getProject(id), materials);
  for (const id of [project.id, other.id]) { await workspace.readNotes(id); await characters.read(id); await library.read(id); }
  const service = new MaterialSyncService(workspace, materials, userData); await service.configure(project.id, false); await service.configure(other.id, false);
  let notes = await workspace.readNotes(project.id);
  notes = await workspace.saveNotes(project.id, { ...notes.value, world: '虚构旧世界，必须完整恢复。' }, notes.hash);
  const canonical = path.join(materials, project.id), historyId = randomUUID(), historyRoot = path.join(materials, '同步历史', project.id), historical = path.join(historyRoot, historyId);
  await fs.mkdir(historyRoot, { recursive: true }); await fs.cp(canonical, historical, { recursive: true });
  const draft = JSON.stringify({ schemaVersion: 1, projectId: project.id, confirmed: false, text: '虚构未确认草稿' });
  await fs.writeFile(path.join(historical, 'draft.json'), draft);
  await workspace.saveNotes(project.id, { ...notes.value, world: '虚构当前世界，必须保留备份。' }, notes.hash);
  const otherNotesPath = path.join(materials, other.id, '创作笔记.md');
  let otherNotes = await workspace.readNotes(other.id); await workspace.saveNotes(other.id, { ...otherNotes.value, world: '另一小说不能改变' }, otherNotes.hash);
  const otherBytes = await fs.readFile(otherNotesPath), statePath = path.join(userData, 'material-sync', `${project.id}.json`), stateBefore = await fs.readFile(statePath);
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = userData; delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  const errors: string[] = [];
  const history = () => page.getByTestId('history-panel'), outer = () => page.getByTestId('material-sync-panel');
  const settled = () => page.waitForFunction(() => document.querySelector('[data-testid="history-panel"]')?.getAttribute('aria-busy') === 'false');
  const openHistory = async () => {
    await page.getByTestId('material-sync-open').click(); await outer().locator('.material-sync-history summary').click(); await outer().getByTestId('history-open').click();
    await history().waitFor(); await settled();
  };
  const select = async (id: string) => {
    await history().locator(`[data-testid="history-version"][data-id="${id}"]`).click();
    await page.waitForFunction(() => !(document.querySelector('[data-testid="history-restore"]') as HTMLButtonElement)?.disabled);
  };
  const confirmRestore = async (decisions: boolean[]) => {
    let index = 0;
    const handler = (dialog: import('playwright').Dialog) => { const accept = decisions[index++]; void (accept ? dialog.accept() : dialog.dismiss()); };
    page.on('dialog', handler);
    try { await history().getByTestId('history-restore').click(); }
    finally { page.off('dialog', handler); }
    assert.equal(index, decisions.length, '必须显示预期数量的确认对话框');
  };
  try {
    app = await electron.launch({ executablePath: executable, args: args.length ? [] : [path.resolve('out/main/index.js')], env });
    if (args.length) {
      const version = JSON.parse(await fs.readFile('package.json', 'utf8')).version;
      const identity = await app.evaluate(({ app: instance }) => ({ packaged: instance.isPackaged, version: instance.getVersion(), path: instance.getAppPath() }));
      assert.equal(identity.packaged, true); assert.equal(identity.version, version);
      assert.equal(await fs.realpath(identity.path), await fs.realpath(path.join(path.dirname(executable), 'resources/app.asar')));
    }
    page = await app.firstWindow(); page.setDefaultTimeout(25000); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, book);
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByText(`已打开「${path.basename(book)}」`, { exact: false }).first().waitFor();
    await page.getByRole('button', { name: '世界观', exact: true }).click(); const note = page.locator('#project-note');
    assert.equal(await note.inputValue(), '虚构当前世界，必须保留备份。');
    await openHistory(); await select(historyId);
    await confirmRestore([false]); assert.equal(await note.inputValue(), '虚构当前世界，必须保留备份。');
    await confirmRestore([true, false]); assert.equal(await note.inputValue(), '虚构当前世界，必须保留备份。');
    assert.deepEqual((await fs.readdir(historyRoot)).sort(), [historyId]);

    // Hidden draft blocks history application and remains available.
    await history().getByTestId('history-close').click(); await outer().getByTestId('material-sync-close').click();
    await note.fill('虚构未保存输入，不能丢失。'); await openHistory(); await select(historyId);
    await confirmRestore([true, true]); await history().getByTestId('history-error').filter({ hasText: /请先保存/u }).waitFor();
    assert.equal(await note.inputValue(), '虚构未保存输入，不能丢失。'); assert.deepEqual((await fs.readdir(historyRoot)).sort(), [historyId]);
    await history().getByTestId('history-close').click(); await outer().getByTestId('material-sync-close').click();
    await note.fill('虚构当前世界，必须保留备份。'); await page.getByRole('button', { name: '保存本书资料', exact: true }).click();
    await page.getByText('本书资料已保存', { exact: true }).waitFor(); await openHistory(); await select(historyId);

    // IPC error after the on-disk swap must still refresh the loaded pages.
    await app.evaluate(({ ipcMain }) => {
      const state = globalThis as any, channel = 'materials-sync:history-restore';
      state.__restoreOriginal = (ipcMain as any)._invokeHandlers.get(channel); ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, ...params) => { await state.__restoreOriginal(event, ...params); throw new Error('虚构换入后应答失败'); });
    });
    await confirmRestore([true, true]); await history().getByTestId('history-error').filter({ hasText: '虚构换入后应答失败' }).waitFor();
    assert.equal(await history().getByTestId('history-restore-refresh-required').count(), 0, '恢复后刷新成功可解除锁定');
    assert.equal(await fs.readFile(path.join(canonical, 'draft.json'), 'utf8'), draft);
    assert.equal(JSON.parse(draft).confirmed, false); assert.deepEqual(await fs.readFile(otherNotesPath), otherBytes); assert.deepEqual(await fs.readFile(statePath), stateBefore);
    const backupId = (await fs.readdir(historyRoot)).find(name => name !== historyId); assert.ok(backupId);
    assert.match(await fs.readFile(path.join(historyRoot, backupId!, '创作笔记.md'), 'utf8'), /虚构当前世界/u);
    await history().getByTestId('history-close').click(); await outer().getByTestId('material-sync-close').click();
    assert.equal(await note.inputValue(), '虚构旧世界，必须完整恢复。', '返回旧页面前必须读取换入结果');
    await app.evaluate(({ ipcMain }) => { const state = globalThis as any, channel = 'materials-sync:history-restore'; ipcMain.removeHandler(channel); ipcMain.handle(channel, state.__restoreOriginal); });

    // Identical history is a no-op; restoring the backup is a single new swap.
    await openHistory(); await select(historyId); const beforeNoop = (await fs.readdir(historyRoot)).sort();
    await confirmRestore([true, true]); await history().getByText(/无需换入/u).waitFor();
    assert.deepEqual((await fs.readdir(historyRoot)).sort(), beforeNoop);
    await select(backupId!); await fs.writeFile(path.join(historyRoot, backupId!, '外部新增.txt'), '外部新资料必须保留');
    await confirmRestore([true, true]); await history().getByTestId('history-error').filter({ hasText: /变化/u }).waitFor();
    assert.equal(await fs.readFile(path.join(historyRoot, backupId!, '外部新增.txt'), 'utf8'), '外部新资料必须保留');
    assert.equal(await note.inputValue(), '虚构旧世界，必须完整恢复。');
    await select(backupId!); await confirmRestore([true, true]); await history().getByText(/历史已还原/u).waitFor();
    await history().getByTestId('history-close').click(); await outer().getByTestId('material-sync-close').click();
    assert.equal(await note.inputValue(), '虚构当前世界，必须保留备份。');

    // Simulated refresh failure locks the old page and closing until retry.
    await openHistory(); await select(historyId);
    await app.evaluate(({ ipcMain }) => {
      const state = globalThis as any, channel = 'materials-sync:status';
      state.__statusOriginal = (ipcMain as any)._invokeHandlers.get(channel); ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => { throw new Error('虚构刷新失败'); });
    });
    await confirmRestore([true, true]); await history().getByTestId('history-restore-refresh-required').waitFor();
    await history().getByTestId('history-error').filter({ hasText: /刷新失败|需要重新核对/u }).waitFor();
    assert.equal(await history().getByTestId('history-close').isDisabled(), true);
    for (const id of ['history-dag-open', 'history-dag-import-open', 'history-import-open', 'history-refresh'])
      assert.equal(await history().getByTestId(id).isDisabled(), true, `${id} 在恢复状态未核对前必须禁用`);
    assert.equal(await history().getByTestId('history-restore-refresh').isEnabled(), true, '重新读取按钮可用');
    await page.waitForFunction(() => (document.querySelector('button.save-exit') as HTMLButtonElement)?.disabled === true);
    assert.equal(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true }))), false);
    await page.screenshot({ path: path.join(fixture, 'refresh-locked.png') });
    await app.evaluate(({ ipcMain }) => { const state = globalThis as any, channel = 'materials-sync:status'; ipcMain.removeHandler(channel); ipcMain.handle(channel, state.__statusOriginal); });
    await history().getByTestId('history-restore-refresh').click(); await history().getByTestId('history-restore-refresh-required').waitFor({ state: 'detached' });
    await history().getByTestId('history-close').click(); await outer().getByTestId('material-sync-close').click();
    assert.equal(await note.inputValue(), '虚构旧世界，必须完整恢复。');
    assert.deepEqual(await fs.readFile(otherNotesPath), otherBytes); assert.deepEqual(await fs.readFile(statePath), stateBefore); assert.deepEqual(errors, []);
    console.log(`Material history restore desktop passed: ${fixture}`);
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(fixture, 'failure.png') }).catch(() => {});
    throw error;
  } finally { if (app) await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
