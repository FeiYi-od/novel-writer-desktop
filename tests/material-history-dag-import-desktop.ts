import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Workspace } from '../src/main/workspace';
import { MaterialSyncService } from '../src/main/material-sync';
import { CharacterStore } from '../src/main/characters';
import { LibraryStore } from '../src/main/library';
import { parseMaterialHistoryDag } from '../src/main/material-history-dag';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
async function tree(root: string) {
  const result: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false);
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else { assert.ok(entry.isFile()); result[path.relative(root, file)] = hash(await fs.readFile(file)); }
    }
  };
  await walk(root); return result;
}
async function children(root: string) {
  try { return (await fs.readdir(root)).sort(); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--exe' && path.isAbsolute(args[1]!)),
    'Usage: tsx tests/material-history-dag-import-desktop.ts [--exe <absolute win-unpacked exe>]');
  const executable = args.length ? path.resolve(args[1]!) : createRequire(import.meta.url)('electron') as string;
  const archivePath = args.length ? path.join(path.dirname(executable), 'resources/app.asar') : null;
  if (archivePath) { const stat = await fs.lstat(archivePath); assert.ok(stat.isFile() && !stat.isSymbolicLink()); }
  const version = JSON.parse(await fs.readFile('package.json', 'utf8')).version as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/material-history-dag-import-desktop-048-'));
  const book = path.join(fixture, 'A/虚构同名历史小说'), otherBook = path.join(fixture, 'B/虚构同名历史小说');
  await fs.mkdir(book, { recursive: true }); await fs.mkdir(otherBook, { recursive: true });
  const userData = path.join(fixture, 'profile'), materials = path.join(userData, '创作资料');
  const workspace = new Workspace(userData, materials); await workspace.initialize();
  const project = await workspace.attach(book), other = await workspace.attach(otherBook);
  const characters = new CharacterStore(id => workspace.getProject(id), materials), library = new LibraryStore(id => workspace.getProject(id), materials);
  for (const id of [project.id, other.id]) { await workspace.readNotes(id); await characters.read(id); await library.read(id); }
  const service = new MaterialSyncService(workspace, materials, userData);
  await service.configure(project.id, false); await service.configure(other.id, false);
  const canonical = path.join(materials, project.id), stateFile = path.join(userData, 'material-sync', `${project.id}.json`);
  const chapter = await workspace.createChapter(project.id, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '\u3000\u3000虚构正文和段首空格不得被导入改变。' }] }] });
  const manuscriptFile = path.join(book, chapter.path), manuscript = await fs.readFile(manuscriptFile);
  const versions = path.join(book, '小说资料/创作资料同步/版本'), output = path.join(book, '小说资料/完整历史导入');
  const common = Buffer.from('\u3000\u3000尚未确认的虚构角色草稿。\r\n'), binary = Buffer.from([0, 255, 1, 128, 3]);
  const publish = async (files: Record<string, Buffer>, parents: string[]) => {
    const id = randomUUID(), folder = path.join(versions, id), entries = [];
    await fs.mkdir(path.join(folder, 'files'), { recursive: true });
    for (const [relative, bytes] of Object.entries(files)) {
      const file = path.join(folder, 'files', relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes);
      entries.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
    }
    const manifest = { schemaVersion: 1, projectId: project.id, revisionId: id, createdAt: new Date().toISOString(), parents, entries };
    const raw = Buffer.from(JSON.stringify(manifest, null, 2).replace(/\n/gu, '\r\n') + '\r\n');
    await fs.writeFile(path.join(folder, 'manifest.json'), raw); return { id, folder, manifest, raw, files };
  };
  const first = await publish({ '人物/草稿.txt': common }, []);
  const left = await publish({ '人物/草稿.txt': common, 'character-originals/虚构.png': binary }, [first.id]);
  const right = await publish({ '人物/草稿.txt': common, '另一分支.txt': Buffer.from('另一完整分支。') }, [first.id]);
  const localId = randomUUID(), local = path.join(materials, '同步历史', project.id, localId);
  await fs.mkdir(local, { recursive: true }); await fs.writeFile(path.join(local, '旧草稿.txt'), common);
  const otherLocalId = randomUUID(), otherLocal = path.join(materials, '同步历史', other.id, otherLocalId);
  await fs.mkdir(otherLocal, { recursive: true }); await fs.writeFile(path.join(otherLocal, '独立.txt'), '另一本小说的独立历史。');
  const sourcePreview = await service.previewHistoryDag(project.id), source = await service.archiveHistoryDag({ projectId: project.id, fingerprint: sourcePreview.fingerprint });
  const archive = await fs.readFile(source.file), completion = await fs.readFile(path.join(source.directory, '完成清单.json'));
  const parsed = parseMaterialHistoryDag(archive, completion, project.id); assert.equal(parsed.manifest.transport.length, 3);
  const otherPreview = await service.previewHistoryDag(other.id), otherSource = await service.archiveHistoryDag({ projectId: other.id, fingerprint: otherPreview.fingerprint });
  const wrongDir = path.join(fixture, 'wrong-name'); await fs.mkdir(wrongDir);
  const wrongFile = path.join(wrongDir, '历史资料.zip'); await fs.writeFile(wrongFile, archive); await fs.writeFile(path.join(wrongDir, '完成清单.json'), completion);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null; let page!: Page;
  const errors: string[] = [], checks: string[] = [];
  const outer = () => page.getByTestId('material-sync-panel'), history = () => page.getByTestId('history-panel'), panel = () => page.getByTestId('history-dag-import-panel');
  const launch = async () => {
    app = await electron.launch({ executablePath: executable, args: archivePath ? [] : [path.resolve('out/main/index.js')], env: { ...env, NOVEL_WRITER_TEST_DATA: userData } });
    if (archivePath) {
      const identity = await app.evaluate(({ app: instance }) => ({ packaged: instance.isPackaged, path: instance.getAppPath(), version: instance.getVersion() }));
      assert.equal(identity.packaged, true); assert.equal(identity.version, version);
      assert.equal(path.relative(await fs.realpath(archivePath), await fs.realpath(identity.path)), '', 'Must execute the supplied app.asar');
    }
    page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => void d.accept());
  };
  const picker = async (file: string | null) => {
    await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => selected === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [selected] }; }, file);
  };
  const openBook = async (folder = book) => {
    await picker(folder); await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByText(`已打开「${path.basename(folder)}」`, { exact: false }).first().waitFor();
  };
  const settle = async () => page.waitForFunction(() => document.querySelector('[data-testid="history-dag-import-panel"]')?.getAttribute('aria-busy') === 'false');
  const openImport = async () => {
    await page.getByTestId('material-sync-open').click(); await outer().locator('.material-sync-history summary').click();
    await outer().getByTestId('history-open').click(); await history().getByTestId('history-dag-import-open').click(); await panel().waitFor(); await settle();
  };
  const closeImport = async () => {
    await panel().getByTestId('history-dag-import-close').click(); await panel().waitFor({ state: 'detached' });
    await history().getByTestId('history-close').click(); await outer().getByTestId('material-sync-close').click();
  };
  const select = async (file: string | null) => { await picker(file); await panel().getByTestId('history-dag-import-select').click(); await settle(); };
  const refresh = async () => { await panel().getByTestId('history-dag-import-refresh').click(); await settle(); };
  const originalHandler = async (channel: string) => {
    await app!.evaluate(({ ipcMain }, name) => { const state = globalThis as any; state.__dagImportHandlers ??= {}; state.__dagImportHandlers[name] = (ipcMain as any)._invokeHandlers.get(name); }, channel);
  };
  const restoreHandler = async (channel: string) => {
    await app!.evaluate(({ ipcMain }, name) => { const state = globalThis as any; ipcMain.removeHandler(name); ipcMain.handle(name, state.__dagImportHandlers[name]); }, channel);
  };
  const exit = async () => { const closed = app!.waitForEvent('close', { timeout: 30000 }); await page.getByRole('button', { name: '保存并退出', exact: true }).click(); await closed; app = null; };
  try {
    await launch(); await openBook(); await page.getByRole('button', { name: '世界观', exact: true }).click();
    const originalNote = await page.locator('#project-note').inputValue(); await page.locator('#project-note').fill('未保存的虚构世界观，导入不能丢失。');
    await openImport(); assert.equal(await history().evaluate(el => Boolean(el.closest('[inert]'))), true);
    await select(null); await panel().getByText(/已取消选择/u).waitFor(); assert.equal(await panel().getByTestId('history-dag-import-preview').count(), 0);
    await select(source.file); await panel().getByTestId('history-dag-import-preview').waitFor();
    if (await panel().getByTestId('history-dag-import-confirm').isEnabled()) {
      await panel().getByTestId('history-dag-import-confirm').click(); await panel().getByTestId('history-dag-import-error').filter({ hasText: '请先保存' }).waitFor();
    } else assert.equal(await panel().getByTestId('history-dag-import-confirm').isDisabled(), true);
    assert.deepEqual(await children(output), []); await page.keyboard.press('Escape'); await panel().waitFor({ state: 'detached' });
    await history().getByTestId('history-close').click(); await outer().getByTestId('material-sync-close').click();
    assert.equal(await page.locator('#project-note').inputValue(), '未保存的虚构世界观，导入不能丢失。');
    await page.locator('#project-note').fill(originalNote); await page.getByRole('button', { name: '保存本书资料', exact: true }).click();
    await page.getByText('本书资料已保存', { exact: true }).waitFor();
    const currentBefore = await tree(canonical), versionsBefore = await tree(versions), localBefore = await tree(local), stateBefore = await fs.readFile(stateFile);
    checks.push('未保存草稿阻止生成，取消及Escape不写副本；外层历史弹层保持隔离');

    await openImport(); await select(source.file); await panel().getByTestId('history-dag-import-preview').waitFor();
    const sha = await panel().getByTestId('history-dag-import-preview').locator('code').textContent(); assert.ok(sha?.includes(hash(archive)));
    await select(null); await panel().getByText(/已取消选择/u).waitFor();
    assert.equal(await panel().getByTestId('history-dag-import-preview').locator('code').textContent(), sha);
    await refresh(); await panel().getByText('归档和当前资料已重新核对。', { exact: true }).waitFor();
    await select(wrongFile); await panel().getByTestId('history-dag-import-error').waitFor();
    assert.equal(await panel().getByTestId('history-dag-import-preview').count(), 0); assert.deepEqual(await children(output), []);

    await select(source.file); await panel().getByTestId('history-dag-import-preview').waitFor();
    await fs.appendFile(source.file, '虚构外部变更'); await panel().getByTestId('history-dag-import-confirm').click();
    await panel().getByTestId('history-dag-import-error').filter({ hasText: /变化|哈希|归档|ZIP/u }).waitFor(); assert.deepEqual(await children(output), []);
    await fs.writeFile(source.file, archive); await select(source.file); await panel().getByTestId('history-dag-import-preview').waitFor();
    const notesFile = path.join(canonical, '创作笔记.md'), notes = await fs.readFile(notesFile); await fs.appendFile(notesFile, '\n虚构外部变更');
    await panel().getByTestId('history-dag-import-confirm').click(); await panel().getByTestId('history-dag-import-error').filter({ hasText: /变化|资料|预览/u }).waitFor();
    assert.deepEqual(await children(output), []); await fs.writeFile(notesFile, notes);
    await select(source.file); await panel().getByTestId('history-dag-import-preview').waitFor();
    await page.screenshot({ path: path.join(fixture, 'dag-import-preview.png') });
    checks.push('取消保留预览，单版本错名、源ZIP外变与当前资料外变拒绝，重选后才能继续');

    await originalHandler('materials-sync:dag-import-copy');
    await app!.evaluate(({ ipcMain }) => {
      const state = globalThis as any, channel = 'materials-sync:dag-import-copy'; ipcMain.removeHandler(channel); state.__dagImportRelease = undefined;
      ipcMain.handle(channel, async (event, ...args) => { await new Promise<void>(resolve => { state.__dagImportRelease = resolve; }); return state.__dagImportHandlers[channel](event, ...args); });
    });
    await panel().getByTestId('history-dag-import-confirm').click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="history-dag-import-close"]') as HTMLButtonElement)?.disabled === true);
    assert.equal(await panel().getByTestId('history-dag-import-confirm').isDisabled(), true); assert.equal(await panel().getByTestId('history-dag-import-select').isDisabled(), true);
    await page.keyboard.press('Escape'); assert.equal(await panel().isVisible(), true);
    await panel().focus(); await page.keyboard.press('Tab'); assert.equal(await panel().evaluate(el => document.activeElement === el), true);
    await page.waitForFunction(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })) === false, undefined, { timeout: 1500 });
    await app!.evaluate(async () => { const state = globalThis as any; for (let i = 0; i < 200 && typeof state.__dagImportRelease !== 'function'; i++) await new Promise(resolve => setTimeout(resolve, 10)); if (!state.__dagImportRelease) throw new Error('Import handler did not start'); state.__dagImportRelease(); });
    await panel().getByTestId('history-dag-import-result').waitFor(); await settle(); await restoreHandler('materials-sync:dag-import-copy');
    const directory = await panel().getByTestId('history-dag-import-result').locator('code').first().textContent(); assert.ok(directory);
    for (const version of [first, left, right]) {
      assert.deepEqual(await fs.readFile(path.join(directory, 'transport', version.id, 'manifest.json')), version.raw);
      for (const [relative, bytes] of Object.entries(version.files)) assert.deepEqual(await fs.readFile(path.join(directory, 'transport', version.id, 'files', relative)), bytes);
    }
    assert.deepEqual(await fs.readFile(path.join(directory, 'local', localId, '旧草稿.txt')), common);
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8')); assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.kind, 'material-history-dag-import-copy'); assert.equal(manifest.projectId, project.id);
    assert.equal((await children(output)).length, 1); assert.equal(await panel().getByTestId('history-dag-import-confirm').isDisabled(), true);
    await panel().getByTestId('history-dag-import-confirm').evaluate(el => (el as HTMLButtonElement).click()); assert.equal((await children(output)).length, 1);
    await panel().getByTestId('history-dag-import-copy-path').click(); await panel().getByText(/副本目录已复制/u).waitFor(); assert.equal(await app!.evaluate(({ clipboard }) => clipboard.readText()), directory);
    assert.deepEqual(await tree(canonical), currentBefore); assert.deepEqual(await tree(versions), versionsBefore); assert.deepEqual(await tree(local), localBefore); assert.deepEqual(await fs.readFile(stateFile), stateBefore);
    assert.deepEqual(await fs.readFile(source.file), archive); assert.deepEqual(await fs.readFile(path.join(source.directory, '完成清单.json')), completion);
    await page.screenshot({ path: path.join(fixture, 'dag-import-success.png') });
    checks.push('真实双分支与本机历史导入为唯一新副本，raw CRLF/二进制/草稿逐字节匹配，完成清单及原稿/源/状态保护通过，忙期退出与焦点受控');

    await closeImport(); await openImport(); await select(source.file); await panel().getByTestId('history-dag-import-preview').waitFor();
    await originalHandler('materials-sync:dag-import-preview');
    for (const mutation of [{ projectId: other.id }, { schemaVersion: 2 }, { directories: -1 }]) {
      await app!.evaluate(({ ipcMain }, change) => { const state = globalThis as any, channel = 'materials-sync:dag-import-preview'; ipcMain.removeHandler(channel); ipcMain.handle(channel, async (event, ...args) => ({ ...await state.__dagImportHandlers[channel](event, ...args), ...change })); }, mutation);
      await refresh(); await panel().getByTestId('history-dag-import-error').filter({ hasText: /不匹配|变化/u }).waitFor(); assert.equal(await panel().getByTestId('history-dag-import-preview').count(), 0);
      await restoreHandler('materials-sync:dag-import-preview'); await select(source.file); await panel().getByTestId('history-dag-import-preview').waitFor();
    }
    await closeImport(); await openBook(otherBook); await openImport(); await select(source.file); await panel().getByTestId('history-dag-import-error').waitFor(); assert.equal(await panel().getByTestId('history-dag-import-preview').count(), 0);
    await select(otherSource.file); await panel().getByTestId('history-dag-import-preview').waitFor(); await originalHandler('materials-sync:dag-import-preview');
    await app!.evaluate(({ ipcMain }, wrongId) => {
      const state = globalThis as any, channel = 'materials-sync:dag-import-preview'; ipcMain.removeHandler(channel); state.__dagImportPreviewRelease = undefined;
      ipcMain.handle(channel, async (event, ...args) => { await new Promise<void>(resolve => { state.__dagImportPreviewRelease = resolve; }); return { ...await state.__dagImportHandlers[channel](event, ...args), projectId: wrongId }; });
    }, project.id);
    await panel().getByTestId('history-dag-import-refresh').click(); await page.waitForFunction(() => (document.querySelector('[data-testid="history-dag-import-close"]') as HTMLButtonElement)?.disabled === true);
    await app!.evaluate(async () => { const state = globalThis as any; for (let i = 0; i < 200 && !state.__dagImportPreviewRelease; i++) await new Promise(resolve => setTimeout(resolve, 10)); if (!state.__dagImportPreviewRelease) throw new Error('Preview handler did not start'); state.__dagImportPreviewRelease(); });
    await panel().getByTestId('history-dag-import-error').filter({ hasText: '不匹配' }).waitFor(); assert.equal(await panel().getByTestId('history-dag-import-preview').count(), 0);
    await restoreHandler('materials-sync:dag-import-preview'); await select(otherSource.file); await panel().getByTestId('history-dag-import-preview').waitFor();
    // The main operation completes but a corrupted response must lock the panel;
    // retrying blindly could otherwise create an accidental duplicate copy.
    await originalHandler('materials-sync:dag-import-copy');
    await app!.evaluate(({ ipcMain }, wrongId) => {
      const state = globalThis as any, channel = 'materials-sync:dag-import-copy'; ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, ...args) => ({ ...await state.__dagImportHandlers[channel](event, ...args), projectId: wrongId }));
    }, project.id);
    await panel().getByTestId('history-dag-import-confirm').click(); await panel().getByTestId('history-dag-import-error').filter({ hasText: '不匹配' }).waitFor();
    assert.equal(await panel().getByTestId('history-dag-import-confirm').isDisabled(), true); assert.equal(await panel().getByTestId('history-dag-import-select').isDisabled(), true);
    const otherOutput = path.join(otherBook, '小说资料/完整历史导入'), otherCopies = await children(otherOutput); assert.equal(otherCopies.length, 1);
    const otherCompletion = JSON.parse(await fs.readFile(path.join(otherOutput, otherCopies[0]!, 'manifest.json'), 'utf8')); assert.equal(otherCompletion.projectId, other.id);
    await panel().getByTestId('history-dag-import-confirm').evaluate(el => (el as HTMLButtonElement).click()); assert.deepEqual(await children(otherOutput), otherCopies);
    await restoreHandler('materials-sync:dag-import-copy'); await closeImport();
    await exit(); await launch(); await openBook(); await page.locator('.chapter-list button').filter({ hasText: chapter.path }).click(); await page.locator('.tiptap p').first().waitFor();
    assert.ok((await page.locator('.tiptap p').first().textContent())?.startsWith('\u3000\u3000')); await exit(); assert.deepEqual(errors, []);
    assert.deepEqual(await fs.readFile(manuscriptFile), manuscript); assert.deepEqual(await tree(canonical), currentBefore); assert.deepEqual(await tree(versions), versionsBefore); assert.deepEqual(await tree(local), localBefore); assert.deepEqual(await fs.readFile(stateFile), stateBefore);
    assert.equal((await children(output)).length, 1); assert.deepEqual(await fs.readFile(source.file), archive); assert.deepEqual(await fs.readFile(path.join(source.directory, '完成清单.json')), completion);
    checks.push('错书/schema/负目录统计、延迟错书响应和伪造成功响应均拒绝，已完成但响应异常时锁定防重复；同名双书隔离，保存退出重开后DOCX双U+3000与来源、现有历史和新副本保持');
    await fs.writeFile(path.join(fixture, 'result.json'), JSON.stringify({ schemaVersion: 1, passed: true, version,
      scope: archivePath ? 'packaged app.asar DAG import, isolated fictional TEST_DATA profile; not NSIS or upgrade' : 'development build, isolated fictional TEST_DATA profile',
      projectId: project.id, otherProjectId: other.id, checks }, null, 2));
    console.log(`Material history DAG import desktop passed. Evidence: ${fixture}`);
  } catch (error) {
    if (page && !page.isClosed()) { await page.screenshot({ path: path.join(fixture, 'failure.png') }).catch(() => {}); await fs.writeFile(path.join(fixture, 'failure-page.txt'), await page.locator('body').innerText().catch(() => '')).catch(() => {}); }
    throw error;
  } finally { const pending = app as ElectronApplication | null; if (pending) await pending.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
