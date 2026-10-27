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

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
async function tree(root: string) {
  const output: Record<string, string> = {};
  const walk = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false);
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else { assert.ok(entry.isFile()); output[path.relative(root, file)] = hash(await fs.readFile(file)); }
    }
  };
  await walk(root); return output;
}
async function children(root: string) {
  try { return (await fs.readdir(root)).sort(); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--exe' && path.isAbsolute(args[1]!)),
    'Usage: tsx tests/material-history-dag-desktop.ts [--exe <absolute win-unpacked exe>]');
  const executable = args.length ? path.resolve(args[1]!) : createRequire(import.meta.url)('electron') as string;
  const archivePath = args.length ? path.join(path.dirname(executable), 'resources/app.asar') : null;
  if (archivePath) { const stat = await fs.lstat(archivePath); assert.ok(stat.isFile() && !stat.isSymbolicLink()); }
  const version = JSON.parse(await fs.readFile('package.json', 'utf8')).version as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/material-history-dag-desktop-047-'));
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
  const chapter = await workspace.createChapter(project.id, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '\u3000\u3000虚构正文和段首空格不得被完整历史归档改变。' }] }] });
  const manuscriptFile = path.join(book, chapter.path), manuscript = await fs.readFile(manuscriptFile);
  const versions = path.join(book, '小说资料/创作资料同步/版本'), archives = path.join(book, '小说资料/完整历史归档');
  const rawSources: Buffer[] = [], common = Buffer.from('\u3000\u3000尚未确认的虚构角色草稿。\r\n'), binary = Buffer.from([0, 255, 1, 128, 3]);
  const publish = async (files: Record<string, Buffer>, parents: string[]) => {
    const id = randomUUID(), folder = path.join(versions, id), entries = [];
    await fs.mkdir(path.join(folder, 'files'), { recursive: true });
    for (const [relative, bytes] of Object.entries(files)) {
      const file = path.join(folder, 'files', relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes);
      entries.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
    }
    const manifest = { schemaVersion: 1, projectId: project.id, revisionId: id, createdAt: new Date().toISOString(), parents, entries };
    const raw = Buffer.from(JSON.stringify(manifest, null, 2).replace(/\n/gu, '\r\n') + '\r\n');
    await fs.writeFile(path.join(folder, 'manifest.json'), raw); rawSources.push(raw);
    return { id, folder, manifest, raw };
  };
  const first = await publish({ '人物/草稿.txt': common }, []);
  const left = await publish({ '人物/草稿.txt': common, 'character-originals/虚构.png': binary }, [first.id]);
  const right = await publish({ '人物/草稿.txt': common, '另一分支.txt': Buffer.from('不可丢弃的另一完整分支。') }, [first.id]);
  const localId = randomUUID(), local = path.join(materials, '同步历史', project.id, localId);
  await fs.mkdir(local, { recursive: true }); await fs.writeFile(path.join(local, '旧草稿.txt'), common);
  const otherLocalId = randomUUID(), otherLocal = path.join(materials, '同步历史', other.id, otherLocalId);
  await fs.mkdir(otherLocal, { recursive: true }); await fs.writeFile(path.join(otherLocal, '独立.txt'), '另一本小说的独立历史。');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null; let page!: Page;
  const errors: string[] = [], checks: string[] = [];
  const outer = () => page.getByTestId('material-sync-panel'), history = () => page.getByTestId('history-panel'), panel = () => page.getByTestId('history-dag-panel');
  const launch = async () => {
    app = await electron.launch({ executablePath: executable, args: archivePath ? [] : [path.resolve('out/main/index.js')], env: { ...env, NOVEL_WRITER_TEST_DATA: userData } });
    if (archivePath) {
      const identity = await app.evaluate(({ app: instance }) => ({ packaged: instance.isPackaged, path: instance.getAppPath(), version: instance.getVersion() }));
      assert.equal(identity.packaged, true); assert.equal(identity.version, version);
      assert.equal(path.relative(await fs.realpath(archivePath), await fs.realpath(identity.path)), '', 'Must execute the supplied app.asar');
    }
    page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => void d.accept());
  };
  const openBook = async (folder = book) => {
    await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByText(`已打开「${path.basename(folder)}」`, { exact: false }).first().waitFor();
  };
  const settle = async () => page.waitForFunction(() => document.querySelector('[data-testid="history-dag-panel"]')?.getAttribute('aria-busy') === 'false');
  const openDag = async () => {
    await page.getByTestId('material-sync-open').click(); await outer().locator('.material-sync-history summary').click();
    await outer().getByTestId('history-open').click(); await history().getByTestId('history-dag-open').click(); await panel().waitFor(); await settle();
  };
  const closeDag = async () => {
    await panel().getByTestId('history-dag-close').click(); await panel().waitFor({ state: 'detached' });
    await history().getByTestId('history-close').click(); await outer().getByTestId('material-sync-close').click();
  };
  const refresh = async () => { await panel().getByTestId('history-dag-refresh').click(); await settle(); };
  const originalHandler = async (channel: string) => {
    await app!.evaluate(({ ipcMain }, name) => {
      const state = globalThis as any; state.__dagHandlers ??= {}; state.__dagHandlers[name] = (ipcMain as any)._invokeHandlers.get(name);
    }, channel);
  };
  const restoreHandler = async (channel: string) => {
    await app!.evaluate(({ ipcMain }, name) => { const state = globalThis as any; ipcMain.removeHandler(name); ipcMain.handle(name, state.__dagHandlers[name]); }, channel);
  };
  const exit = async () => {
    const closed = app!.waitForEvent('close', { timeout: 30000 });
    await page.getByRole('button', { name: '保存并退出', exact: true }).click(); await closed; app = null;
  };
  try {
    await launch(); await openBook(); await page.getByRole('button', { name: '世界观', exact: true }).click();
    const originalNote = await page.locator('#project-note').inputValue();
    await page.locator('#project-note').fill('未保存的虚构世界观，归档不能丢失。'); await openDag();
    await panel().getByTestId('history-dag-preview').waitFor();
    if (await panel().getByTestId('history-dag-confirm').isEnabled()) {
      await panel().getByTestId('history-dag-confirm').click(); await panel().getByTestId('history-dag-error').filter({ hasText: '请先保存' }).waitFor();
    } else assert.equal(await panel().getByTestId('history-dag-confirm').isDisabled(), true);
    assert.deepEqual(await children(archives), []);
    await page.keyboard.press('Escape'); await panel().waitFor({ state: 'detached' }); assert.equal(await history().isVisible(), true);
    await history().getByTestId('history-close').click(); await outer().getByTestId('material-sync-close').click();
    assert.equal(await page.locator('#project-note').inputValue(), '未保存的虚构世界观，归档不能丢失。');
    await page.locator('#project-note').fill(originalNote); await page.getByRole('button', { name: '保存本书资料', exact: true }).click();
    await page.getByText('本书资料已保存', { exact: true }).waitFor();
    checks.push('未保存草稿阻止生成且完整保留；Escape只关闭归档层，不改变当前设定');

    const currentBefore = await tree(canonical), versionsBefore = await tree(versions), localBefore = await tree(local), stateBefore = await fs.readFile(stateFile);
    await openDag(); await panel().getByTestId('history-dag-preview').waitFor();
    const preview = await page.evaluate(id => window.writer.previewMaterialHistoryDag(id), project.id);
    assert.equal(preview.transportVersions, 3); assert.equal(preview.localArchives, 1); assert.equal(preview.branches, 2);
    assert.equal(await history().evaluate(el => Boolean(el.closest('[inert]'))), true);
    await panel().focus(); await page.keyboard.press('Shift+Tab');
    assert.equal(await panel().getByTestId('history-dag-confirm').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Tab'); assert.equal(await panel().getByTestId('history-dag-close').evaluate(el => el === document.activeElement), true);
    await page.screenshot({ path: path.join(fixture, 'dag-preview.png') });
    await originalHandler('materials-sync:dag-archive');
    await app!.evaluate(({ ipcMain }) => {
      const state = globalThis as any, channel = 'materials-sync:dag-archive'; ipcMain.removeHandler(channel); state.__dagRelease = undefined;
      ipcMain.handle(channel, async (event, ...args) => { await new Promise<void>(resolve => { state.__dagRelease = resolve; }); return state.__dagHandlers[channel](event, ...args); });
    });
    await panel().getByTestId('history-dag-confirm').click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="history-dag-close"]') as HTMLButtonElement)?.disabled === true);
    assert.equal(await panel().getByTestId('history-dag-confirm').isDisabled(), true); assert.equal(await panel().getByTestId('history-dag-refresh').isDisabled(), true);
    await page.keyboard.press('Escape'); assert.equal(await panel().isVisible(), true);
    await panel().focus(); await page.keyboard.press('Tab'); assert.equal(await panel().evaluate(el => document.activeElement === el), true);
    await page.waitForFunction(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })) === false, undefined, { timeout: 1500 });
    assert.equal(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true }))), false);
    await app!.evaluate(async () => { const state = globalThis as any; for (let i = 0; i < 200 && typeof state.__dagRelease !== 'function'; i++) await new Promise(resolve => setTimeout(resolve, 10)); if (!state.__dagRelease) throw new Error('Export handler did not start'); state.__dagRelease(); });
    await panel().getByTestId('history-dag-result').waitFor(); await settle(); await restoreHandler('materials-sync:dag-archive');
    const file = await panel().getByTestId('history-dag-result').locator('code').first().textContent(); assert.ok(file);
    const directory = path.dirname(file), archive = await fs.readFile(file), completion = await fs.readFile(path.join(directory, '完成清单.json'));
    const parsed = parseMaterialHistoryDag(archive, completion, project.id);
    assert.equal(parsed.manifest.kind, 'material-history-dag-archive');
    assert.deepEqual(new Set(parsed.manifest.transport.map(value => value.id)), new Set([first.id, left.id, right.id]));
    assert.deepEqual(new Set(parsed.manifest.leaves), new Set([left.id, right.id])); assert.equal(parsed.manifest.local[0]!.id, localId);
    for (const raw of rawSources) assert.deepEqual(parsed.blobs.get(hash(raw)), raw);
    assert.deepEqual(parsed.blobs.get(hash(common)), common); assert.deepEqual(parsed.blobs.get(hash(binary)), binary);
    assert.equal((await children(archives)).length, 1); assert.equal(await panel().getByTestId('history-dag-confirm').isDisabled(), true);
    await panel().getByTestId('history-dag-confirm').evaluate(el => (el as HTMLButtonElement).click()); assert.equal((await children(archives)).length, 1);
    await panel().getByTestId('history-dag-copy-path').click(); await panel().getByText('完整历史ZIP路径已复制', { exact: true }).waitFor();
    assert.equal(await app!.evaluate(({ clipboard }) => clipboard.readText()), file);
    assert.deepEqual(await tree(canonical), currentBefore); assert.deepEqual(await tree(versions), versionsBefore); assert.deepEqual(await tree(local), localBefore); assert.deepEqual(await fs.readFile(stateFile), stateBefore);
    await page.screenshot({ path: path.join(fixture, 'dag-success.png') });
    checks.push('真实三版本双分支及本机归档均入包；raw CRLF/草稿/二进制与父链保留、哈希去重、完成清单有效、唯一副本与复制路径；忙期关闭/重复/退出/焦点受控');

    await closeDag(); await openDag(); await panel().getByTestId('history-dag-preview').waitFor();
    const leftFile = path.join(left.folder, 'files/人物/草稿.txt'); await fs.writeFile(leftFile, '虚构外部变化');
    await panel().getByTestId('history-dag-confirm').click(); await panel().getByTestId('history-dag-error').filter({ hasText: /变化|哈希|完整|不匹配/u }).waitFor();
    assert.equal((await children(archives)).length, 1); assert.equal(await panel().getByTestId('history-dag-preview').count(), 0);
    await fs.writeFile(leftFile, common); await refresh(); await panel().getByTestId('history-dag-preview').waitFor();
    const partial = path.join(versions, randomUUID()); await fs.mkdir(partial); await refresh();
    await panel().getByTestId('history-dag-error').waitFor(); assert.equal(await panel().getByTestId('history-dag-preview').count(), 0); assert.equal((await children(archives)).length, 1);
    await fs.rmdir(partial); // Explicitly empty, uniquely named fictional test directory only.
    await fs.writeFile(path.join(left.folder, 'manifest.json'), JSON.stringify({ ...left.manifest, parents: [randomUUID()] })); await refresh();
    await panel().getByTestId('history-dag-error').filter({ hasText: /父|历史|完整/u }).waitFor(); assert.equal(await panel().getByTestId('history-dag-preview').count(), 0);
    await fs.writeFile(path.join(left.folder, 'manifest.json'), left.raw); await refresh(); await panel().getByTestId('history-dag-preview').waitFor();
    checks.push('预览后来源变化、未完成上传与缺失父版本均拒绝；无部分成功归档、旧完整包和当前资料保持');

    await originalHandler('materials-sync:dag-preview');
    for (const change of [{ projectId: other.id }, { schemaVersion: 2 }, { bytes: -1 }]) {
      await app!.evaluate(({ ipcMain }, mutation) => {
        const state = globalThis as any, channel = 'materials-sync:dag-preview'; ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (event, ...args) => ({ ...await state.__dagHandlers[channel](event, ...args), ...mutation }));
      }, change);
      await refresh(); await panel().getByTestId('history-dag-error').filter({ hasText: '不匹配' }).waitFor();
      assert.equal(await panel().getByTestId('history-dag-preview').count(), 0);
    }
    await restoreHandler('materials-sync:dag-preview'); await closeDag(); await openBook(otherBook); await openDag();
    await panel().getByTestId('history-dag-preview').waitFor();
    const otherPreview = await page.evaluate(id => window.writer.previewMaterialHistoryDag(id), other.id);
    assert.equal(otherPreview.transportVersions, 0); assert.equal(otherPreview.localArchives, 1);
    await originalHandler('materials-sync:dag-preview');
    await app!.evaluate(({ ipcMain }, wrongId) => {
      const state = globalThis as any, channel = 'materials-sync:dag-preview'; ipcMain.removeHandler(channel); state.__dagPreviewRelease = undefined;
      ipcMain.handle(channel, async (event, ...args) => { await new Promise<void>(resolve => { state.__dagPreviewRelease = resolve; }); return { ...await state.__dagHandlers[channel](event, ...args), projectId: wrongId }; });
    }, project.id);
    await panel().getByTestId('history-dag-refresh').click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="history-dag-close"]') as HTMLButtonElement)?.disabled === true);
    await app!.evaluate(async () => { const state = globalThis as any; for (let i = 0; i < 200 && !state.__dagPreviewRelease; i++) await new Promise(resolve => setTimeout(resolve, 10)); if (!state.__dagPreviewRelease) throw new Error('Preview handler did not start'); state.__dagPreviewRelease(); });
    await panel().getByTestId('history-dag-error').filter({ hasText: '不匹配' }).waitFor(); assert.equal(await panel().getByTestId('history-dag-preview').count(), 0);
    await restoreHandler('materials-sync:dag-preview'); await closeDag(); assert.deepEqual(await children(path.join(otherBook, '小说资料/完整历史归档')), []);
    await exit(); await launch(); await openBook(); await openDag(); await panel().getByTestId('history-dag-preview').waitFor();
    await closeDag(); await page.locator('.chapter-list button').filter({ hasText: chapter.path }).click(); await page.locator('.tiptap p').first().waitFor();
    assert.ok((await page.locator('.tiptap p').first().textContent())?.startsWith('\u3000\u3000'));
    await exit(); assert.deepEqual(errors, []); assert.deepEqual(await fs.readFile(manuscriptFile), manuscript);
    assert.deepEqual(await tree(canonical), currentBefore); assert.deepEqual(await tree(versions), versionsBefore); assert.deepEqual(await tree(local), localBefore); assert.deepEqual(await fs.readFile(stateFile), stateBefore);
    assert.equal((await children(archives)).length, 1); assert.deepEqual(await fs.readFile(file), archive); assert.deepEqual(await fs.readFile(path.join(directory, '完成清单.json')), completion);
    checks.push('错书/schema/矛盾统计与延迟错书结果拒绝，同名双书独立；保存退出重开保留DOCX真实双U+3000、全部来源和已完成归档原字节');
    await fs.writeFile(path.join(fixture, 'result.json'), JSON.stringify({ schemaVersion: 1, passed: true, version,
      scope: archivePath ? 'packaged app.asar DAG export, isolated fictional TEST_DATA profile; not NSIS or upgrade' : 'development build, isolated fictional TEST_DATA profile',
      projectId: project.id, otherProjectId: other.id, checks }, null, 2));
    console.log(`Material history DAG desktop passed. Evidence: ${fixture}`);
  } catch (error) {
    if (page && !page.isClosed()) { await page.screenshot({ path: path.join(fixture, 'failure.png') }).catch(() => {}); await fs.writeFile(path.join(fixture, 'failure-page.txt'), await page.locator('body').innerText().catch(() => '')).catch(() => {}); }
    throw error;
  } finally { const pending = app as ElectronApplication | null; if (pending) await pending.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
