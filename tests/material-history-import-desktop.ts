import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Workspace } from '../src/main/workspace';
import { MaterialSyncService } from '../src/main/material-sync';
import { notesMarkdown, parseNotesMarkdown } from '../src/main/markdown-materials';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function tree(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const visit = async (directory: string) => {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      assert.equal(item.isSymbolicLink(), false);
      if (item.isDirectory()) await visit(file);
      else files[path.relative(root, file)] = digest(await fs.readFile(file));
    }
  };
  await visit(root); return files;
}
async function children(root: string) {
  try { return (await fs.readdir(root)).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/material-history-import-desktop-040-'));
  const book = path.join(fixture, 'A/虚构同名星港'), another = path.join(fixture, 'B/虚构同名星港');
  await fs.mkdir(book, { recursive: true }); await fs.mkdir(another, { recursive: true });
  const userData = path.join(fixture, 'profile'), materialsRoot = path.join(userData, '创作资料');
  const workspace = new Workspace(userData, materialsRoot); await workspace.initialize();
  const project = await workspace.attach(book), id = project.id;
  const oldWorld = '旧设定：虚构星港以月光供能。', currentWorld = '现设定：虚构星港以潮汐供能。';
  const initial = await workspace.readNotes(id); await workspace.saveNotes(id, { ...initial.value, world: oldWorld }, initial.hash);
  const chapter = await workspace.createChapter(id, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '\u3000\u3000虚构正文与可复制空格必须保留。' }] }] });
  const manuscript = await fs.readFile(path.join(book, chapter.path));
  const canonical = path.join(materialsRoot, id), notesFile = path.join(canonical, '创作笔记.md');
  await fs.writeFile(path.join(canonical, '筹备草稿.txt'), '\u3000\u3000未确认草稿：领航员可能来自北岸。');
  await fs.writeFile(path.join(canonical, '参考片段.docx'), manuscript);
  const service = new MaterialSyncService(workspace, materialsRoot, userData);
  await service.configure(id, true); await service.synchronize({ projectId: id });
  const version = (await service.history(id)).versions.find(value => value.source === 'transport')!;
  const sourcePreview = await service.previewHistory({ projectId: id, source: version.source, id: version.id });
  const archive = await service.archiveHistory({ projectId: id, source: version.source, id: version.id, fingerprint: sourcePreview.fingerprint });
  const oldFiles = path.join(book, '小说资料/创作资料同步/版本', version.id, 'files');
  const latest = await workspace.readNotes(id); await workspace.saveNotes(id, { ...latest.value, world: currentWorld }, latest.hash);
  await service.synchronize({ projectId: id });
  const otherProject = await workspace.attach(another), otherId = otherProject.id;
  const otherNotes = await workspace.readNotes(otherId);
  await workspace.saveNotes(otherId, { ...otherNotes.value, world: '第二本小说的独立设定。' }, otherNotes.hash);
  const missingDirectory = path.join(fixture, '缺少完成清单'); await fs.mkdir(missingDirectory);
  const missingArchive = path.join(missingDirectory, '历史资料.zip'); await fs.copyFile(archive.file, missingArchive);
  const changingDirectory = path.join(fixture, '外部变化归档'); await fs.mkdir(changingDirectory);
  const changingArchive = path.join(changingDirectory, '历史资料.zip');
  await fs.copyFile(archive.file, changingArchive);
  await fs.copyFile(path.join(archive.directory, '完成清单.json'), path.join(changingDirectory, '完成清单.json'));
  const imports = path.join(book, '小说资料/资料历史导入'), stateFile = path.join(userData, 'material-sync', `${id}.json`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null; let page!: Page; let sync!: Locator; let history!: Locator; let importing!: Locator;
  const errors: string[] = [], checks: string[] = [];
  const launch = async () => {
    app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [path.resolve('out/main/index.js')], env: { ...env, NOVEL_WRITER_TEST_DATA: userData } });
    page = await app.firstWindow(); page.setDefaultTimeout(20_000); page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => void dialog.accept());
    sync = page.getByTestId('material-sync-panel'); history = page.getByTestId('history-panel'); importing = page.getByTestId('history-import-panel');
  };
  const openBook = async (folder = book) => {
    await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByText(`已打开「${path.basename(folder)}」`, { exact: false }).first().waitFor();
  };
  const openImporter = async () => {
    await page.getByTestId('material-sync-open').click(); await sync.locator('.material-sync-history summary').click();
    await sync.getByTestId('history-open').click(); await history.getByTestId('history-import-open').click();
    await importing.waitFor();
  };
  const closeImporter = async () => {
    await importing.getByTestId('history-import-close').click(); await importing.waitFor({ state: 'detached' });
    await history.getByTestId('history-close').click(); await sync.getByTestId('material-sync-close').click();
  };
  const picker = async (file: string | null) => {
    await app!.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async (...args: any[]) => {
        const options = args.at(-1) as { title?: string; filters?: unknown };
        if (options?.title !== '导入已完成的资料历史ZIP' || JSON.stringify(options.filters) !== JSON.stringify([{ name: '资料历史ZIP', extensions: ['zip'] }]))
          throw new Error('导入界面未使用限定的原生ZIP选择器');
        return { canceled: selected === null, filePaths: selected === null ? [] : [selected] };
      };
    }, file);
    await importing.getByTestId('history-import-pick').click();
  };
  const pickValid = async (file = archive.file) => { await picker(file); await importing.getByTestId('history-import-preview').waitFor(); };
  const selectNotes = async () => {
    await importing.locator('[data-testid="history-import-file"][data-path="创作笔记.md"]').click();
    await importing.locator('.material-history-side pre').filter({ hasText: oldWorld }).waitFor();
  };
  const exitNormally = async () => {
    const closed = app!.waitForEvent('close', { timeout: 30_000 });
    await page.getByRole('button', { name: '保存并退出', exact: true }).click(); await closed; app = null;
  };
  try {
    await launch(); await openBook(); await page.getByRole('button', { name: '世界观', exact: true }).click();
    assert.equal(await page.locator('#project-note').inputValue(), currentWorld);
    await page.locator('#project-note').fill('未保存的作者草稿，不能因导入而丢失。'); await openImporter();
    await picker(null); await importing.getByText('已取消选择，未创建副本。', { exact: true }).waitFor();
    assert.deepEqual(await children(imports), []);
    await pickValid(); await selectNotes();
    await importing.getByTestId('history-import-confirm').click();
    await importing.getByTestId('history-import-error').filter({ hasText: '请先保存' }).waitFor();
    assert.deepEqual(await children(imports), []);
    await page.keyboard.press('Escape'); await importing.waitFor({ state: 'detached' });
    assert.ok(await history.isVisible()); await history.getByTestId('history-close').click(); await sync.getByTestId('material-sync-close').click();
    assert.equal(await page.locator('#project-note').inputValue(), '未保存的作者草稿，不能因导入而丢失。');
    await page.locator('#project-note').fill(currentWorld); await page.getByRole('button', { name: '保存本书资料', exact: true }).click();
    await page.getByText('本书资料已保存', { exact: true }).waitFor();
    checks.push('取消不创建副本、只读预览可用、未保存草稿阻止确认并完整保留、Escape只关闭导入层');

    await openImporter(); await picker(missingArchive);
    await importing.getByTestId('history-import-error').waitFor(); assert.equal(await importing.getByTestId('history-import-preview').count(), 0);
    assert.deepEqual(await children(imports), []);
    await pickValid(); await selectNotes();
    assert.equal(await importing.locator('.material-history-side pre').filter({ hasText: currentWorld }).count(), 1);
    assert.equal(await history.evaluate(element => Boolean(element.closest('[inert]'))), true);
    await importing.focus(); await page.keyboard.press('Shift+Tab');
    assert.equal(await importing.getByTestId('history-import-confirm').evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Tab'); assert.equal(await importing.getByTestId('history-import-close').evaluate(element => element === document.activeElement), true);
    await page.screenshot({ path: path.join(fixture, 'history-import-preview.png') });
    checks.push('必须同带完成清单、当前与归档双栏纯文本、外层inert与键盘焦点循环');

    await app!.evaluate(({ dialog }) => {
      const state = globalThis as unknown as { historyZipPicker?: { calls: number; resolve?: (value: { canceled: boolean; filePaths: string[] }) => void } };
      state.historyZipPicker = { calls: 0 };
      dialog.showOpenDialog = async () => {
        state.historyZipPicker!.calls++;
        return new Promise<{ canceled: boolean; filePaths: string[] }>(resolve => { state.historyZipPicker!.resolve = resolve; });
      };
    });
    await importing.getByTestId('history-import-pick').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="history-import-panel"]')?.getAttribute('aria-busy') === 'true');
    assert.ok(await importing.getByTestId('history-import-close').isDisabled()); assert.ok(await importing.getByTestId('history-import-pick').isDisabled());
    await page.keyboard.press('Escape'); assert.ok(await importing.isVisible());
    await importing.focus(); await page.keyboard.press('Tab'); assert.equal(await importing.evaluate(element => element === document.activeElement), true);
    await page.waitForFunction(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })) === false, undefined, { timeout: 1500 });
    assert.equal(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true }))), false);
    assert.equal(app!.process().exitCode, null);
    assert.equal(await app!.evaluate(() => (globalThis as unknown as { historyZipPicker: { calls: number } }).historyZipPicker.calls), 1);
    await app!.evaluate((_, selected) => {
      const state = globalThis as unknown as { historyZipPicker: { resolve?: (value: { canceled: boolean; filePaths: string[] }) => void } };
      if (!state.historyZipPicker.resolve) throw new Error('选择器没有进入等待状态');
      state.historyZipPicker.resolve({ canceled: false, filePaths: [selected] });
    }, archive.file);
    await importing.getByTestId('history-import-preview').waitFor();
    const currentBefore = await tree(canonical), transportBefore = await tree(path.join(book, '小说资料/创作资料同步'));
    const archiveBefore = await tree(archive.directory), stateBefore = await fs.readFile(stateFile);
    await app!.evaluate(({ ipcMain }) => {
      const channel = 'materials-sync:history-import-copy', handler = (ipcMain as any)._invokeHandlers.get(channel);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, ...args) => { await new Promise(resolve => setTimeout(resolve, 1200)); return handler(event, ...args); });
    });
    await importing.getByTestId('history-import-confirm').click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="history-import-close"]') as HTMLButtonElement)?.disabled === true);
    assert.ok(await importing.getByTestId('history-import-confirm').isDisabled());
    await page.waitForFunction(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })) === false, undefined, { timeout: 1500 });
    await importing.getByTestId('history-import-result').waitFor();
    const destination = await importing.getByTestId('history-import-result').locator('code').textContent(); assert.ok(destination);
    const manifest = JSON.parse(await fs.readFile(path.join(destination, 'manifest.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.projectId, id); assert.equal(manifest.kind, 'material-history-import-copy');
    assert.deepEqual(await tree(path.join(destination, 'files')), await tree(oldFiles));
    assert.equal(await fs.readFile(path.join(destination, 'files/筹备草稿.txt'), 'utf8'), '\u3000\u3000未确认草稿：领航员可能来自北岸。');
    assert.deepEqual(await fs.readFile(path.join(destination, 'files/参考片段.docx')), manuscript);
    assert.deepEqual(await tree(canonical), currentBefore); assert.deepEqual(await fs.readFile(stateFile), stateBefore);
    assert.deepEqual(await tree(path.join(book, '小说资料/创作资料同步')), transportBefore); assert.deepEqual(await tree(archive.directory), archiveBefore);
    assert.deepEqual(await fs.readFile(path.join(book, chapter.path)), manuscript); assert.equal((await children(imports)).length, 1);
    assert.ok(await importing.getByTestId('history-import-confirm').isDisabled());
    await importing.getByTestId('history-import-confirm').evaluate(element => (element as HTMLButtonElement).click());
    assert.equal((await children(imports)).length, 1);
    await importing.getByTestId('history-import-copy-directory').click(); await importing.getByText('导入副本目录已复制', { exact: true }).waitFor();
    assert.equal(await app!.evaluate(({ clipboard }) => clipboard.readText()), destination);
    await page.screenshot({ path: path.join(fixture, 'history-import-success.png') });
    checks.push('选择和导入忙期拒绝关闭/重复/退出、一次新副本与完成清单、原稿/正式资料/基线/历史/归档原字节保留、双U+3000与DOCX原字节、复制目录');

    await pickValid(changingArchive); await selectNotes();
    await fs.appendFile(changingArchive, Buffer.from('外部追加必须拒绝'));
    const copiesBefore = await children(imports);
    await importing.getByTestId('history-import-confirm').click(); await importing.getByTestId('history-import-error').waitFor();
    assert.deepEqual(await children(imports), copiesBefore); assert.deepEqual(await tree(canonical), currentBefore);
    await pickValid(); await selectNotes();
    const changed = parseNotesMarkdown(await fs.readFile(notesFile, 'utf8'), id);
    await fs.writeFile(notesFile, notesMarkdown({ ...changed, world: '外部最新世界观，不能被历史覆盖。' }));
    await importing.getByTestId('history-import-confirm').click();
    await importing.getByTestId('history-import-error').filter({ hasText: '变化' }).waitFor();
    assert.deepEqual(await children(imports), copiesBefore);
    assert.equal(parseNotesMarkdown(await fs.readFile(notesFile, 'utf8'), id).world, '外部最新世界观，不能被历史覆盖。');
    assert.deepEqual(await fs.readFile(stateFile), stateBefore); assert.deepEqual(await tree(archive.directory), archiveBefore);
    await page.screenshot({ path: path.join(fixture, 'history-import-stale.png') });
    await closeImporter();
    checks.push('预览后ZIP及当前资料外变拒绝发布，旧副本和外部最新内容保留');

    await openBook(another); await openImporter();
    const otherCanonical = path.join(materialsRoot, otherId), otherBefore = await tree(otherCanonical);
    await picker(archive.file); await importing.getByTestId('history-import-error').waitFor();
    assert.equal(await importing.getByTestId('history-import-preview').count(), 0);
    assert.deepEqual(await children(path.join(another, '小说资料/资料历史导入')), []);
    assert.deepEqual(await tree(otherCanonical), otherBefore); assert.deepEqual(await children(imports), copiesBefore);
    await closeImporter(); await exitNormally(); await launch(); await openBook();
    await page.getByRole('button', { name: '世界观', exact: true }).click();
    assert.equal(await page.locator('#project-note').inputValue(), '外部最新世界观，不能被历史覆盖。');
    await page.locator('.chapter-list button').filter({ hasText: chapter.path }).click(); await page.locator('.tiptap').waitFor();
    assert.ok((await page.locator('.tiptap p').first().textContent())?.startsWith('\u3000\u3000'));
    assert.deepEqual(await fs.readFile(path.join(book, chapter.path)), manuscript);
    assert.deepEqual(await tree(path.join(destination, 'files')), await tree(oldFiles));
    await exitNormally(); assert.deepEqual(errors, []);
    checks.push('同名双书拒绝错书归档、独立目录隔离、保存退出重开及原稿可复制全角空格');
    await fs.writeFile(path.join(fixture, 'result.json'), JSON.stringify({ schemaVersion: 1, passed: true, projectId: id, otherProjectId: otherId, directory: destination, checks }, null, 2));
    console.log(`Material history import desktop passed. Evidence: ${fixture}`);
  } catch (failure) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(fixture, 'failure.png') }).catch(() => {});
      await fs.writeFile(path.join(fixture, 'failure-page.txt'), await page.locator('body').innerText().catch(() => '')).catch(() => {});
    }
    throw failure;
  } finally { const remaining = app as ElectronApplication | null; if (remaining) await remaining.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(failure => { console.error(failure); process.exitCode = 1; });
