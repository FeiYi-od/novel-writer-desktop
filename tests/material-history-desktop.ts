import { _electron as electron, type ElectronApplication, type Page, type Locator } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { Workspace } from '../src/main/workspace';
import { MaterialSyncService } from '../src/main/material-sync';
import { notesMarkdown, parseNotesMarkdown } from '../src/main/markdown-materials';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function tree(folder: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(directory: string) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await walk(file);
      else result[path.relative(folder, file)] = digest(await fs.readFile(file));
    }
  }
  await walk(folder); return result;
}

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/material-history-desktop-036-'));
  const book = path.join(fixture, '虚构历史星港'); await fs.mkdir(book);
  const aData = path.join(fixture, 'A'), bData = path.join(fixture, 'B');
  const aRoot = path.join(aData, '创作资料'), bRoot = path.join(bData, '创作资料');
  const a = new Workspace(aData, aRoot); await a.initialize(); const project = await a.attach(book), id = project.id;
  const first = await a.readNotes(id); await a.saveNotes(id, { ...first.value, world: '旧设定：虚构星港由月光供能。' }, first.hash);
  const canonical = path.join(aRoot, id);
  await fs.writeFile(path.join(canonical, '筹备草稿.txt'), '未确认草稿：领航员可能来自北岸。');
  const chapter = await a.createChapter(id, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '\u3000\u3000虚构星港的正文保留。' }] }] });
  const manuscript = await fs.readFile(path.join(book, chapter.path));
  const service = new MaterialSyncService(a, aRoot, aData); await service.configure(id, true); await service.synchronize({ projectId: id });
  const originalHistory = (await service.history(id)).versions.find(item => item.source === 'transport')!;
  const b = new Workspace(bData, bRoot); await b.initialize(); await b.attach(book);
  const second = new MaterialSyncService(b, bRoot, bData); await second.synchronize({ projectId: id });
  const bNotes = await b.readNotes(id); await b.saveNotes(id, { ...bNotes.value, world: '现设定：虚构星港改由潮汐供能。' }, bNotes.hash);
  await second.synchronize({ projectId: id }); await service.synchronize({ projectId: id });
  assert.ok((await service.history(id)).versions.some(item => item.source === 'local'));
  const oldFolder = path.join(book, '小说资料/创作资料同步/版本', originalHistory.id, 'files');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | undefined; let page!: Page; let panel!: Locator; let history!: Locator;
  const errors: string[] = [];
  const launch = async () => {
    app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [path.resolve('out/main/index.js')], env: { ...env, NOVEL_WRITER_TEST_DATA: aData } });
    page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => void d.accept());
    panel = page.getByTestId('material-sync-panel'); history = page.getByTestId('history-panel');
  };
  const openBook = async (folder = book) => {
    await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByText(`已打开「${path.basename(folder)}」`, { exact: false }).first().waitFor();
  };
  const openHistory = async () => {
    await page.getByTestId('material-sync-open').click();
    await panel.locator('.material-sync-history summary').click(); await panel.getByTestId('history-open').click();
    await history.getByTestId('history-version').first().waitFor();
  };
  const selectOriginal = async () => {
    await history.locator(`[data-testid="history-version"][data-source="transport"][data-id="${originalHistory.id}"]`).click();
    await history.locator('[data-testid="history-file"][data-path="创作笔记.md"]').click();
    await history.locator('.material-history-side pre').filter({ hasText: '旧设定：' }).waitFor();
  };
  const closeHistory = async () => { await history.getByTestId('history-close').click(); await panel.getByTestId('material-sync-close').click(); };
  const exit = async () => { const closed = app!.waitForEvent('close', { timeout: 25000 }); await page.getByRole('button', { name: '保存并退出', exact: true }).click(); await closed; app = undefined; };
  try {
    await launch(); await openBook(); await page.getByRole('button', { name: '世界观', exact: true }).click();
    assert.equal(await page.locator('#project-note').inputValue(), '现设定：虚构星港改由潮汐供能。');
    // Read-only preview remains possible with unsaved notes; copying must retain the draft.
    await page.locator('#project-note').fill('尚未保存的作者草稿'); await openHistory(); await selectOriginal();
    await history.getByTestId('history-copy').click(); await history.getByTestId('history-error').filter({ hasText: '请先保存' }).waitFor();
    await assert.rejects(fs.access(path.join(book, '小说资料/资料历史恢复')));
    await closeHistory(); assert.equal(await page.locator('#project-note').inputValue(), '尚未保存的作者草稿');
    await page.locator('#project-note').fill('现设定：虚构星港改由潮汐供能。');
    await page.getByRole('button', { name: '保存本书资料', exact: true }).click(); await page.getByText('本书资料已保存', { exact: true }).waitFor();
    await openHistory(); await selectOriginal();
    const currentBefore = await tree(canonical), transportBefore = await tree(path.join(book, '小说资料/创作资料同步'));
    const localBefore = await tree(path.join(aRoot, '同步历史', id)), stateFile = path.join(aData, 'material-sync', `${id}.json`), stateBefore = await fs.readFile(stateFile);
    // Delay only this fixture's IPC transport so in-flight controls can be observed.
    await app!.evaluate(({ ipcMain }) => {
      const channel = 'materials-sync:history-copy', handler = (ipcMain as any)._invokeHandlers.get(channel);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, ...args) => { await new Promise(resolve => setTimeout(resolve, 1500)); return handler(event, ...args); });
    });
    await history.getByTestId('history-copy').click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="history-close"]') as HTMLButtonElement)?.disabled === true);
    assert.equal(await history.getByTestId('history-close').isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '保存并退出', exact: true }).isDisabled(), true);
    assert.equal(await panel.evaluate(element => Boolean(element.closest('[inert]'))), true);
    await page.keyboard.press('Tab');
    assert.equal(await history.evaluate(element => element.contains(document.activeElement)), true);
    await history.getByTestId('history-result').waitFor();
    const destination = await history.getByTestId('history-result').locator('code').textContent(); assert.ok(destination);
    const manifest = JSON.parse(await fs.readFile(path.join(destination!, 'manifest.json'), 'utf8'));
    assert.equal(manifest.projectId, id); assert.equal(manifest.id, originalHistory.id); assert.equal(manifest.kind, 'material-history-copy');
    assert.deepEqual(await tree(path.join(destination!, 'files')), await tree(oldFolder));
    assert.equal(await fs.readFile(path.join(destination!, 'files/筹备草稿.txt'), 'utf8'), '未确认草稿：领航员可能来自北岸。');
    assert.deepEqual(await tree(canonical), currentBefore); assert.deepEqual(await tree(path.join(book, '小说资料/创作资料同步')), transportBefore);
    assert.deepEqual(await tree(path.join(aRoot, '同步历史', id)), localBefore); assert.deepEqual(await fs.readFile(stateFile), stateBefore);
    await history.getByTestId('history-copy-directory').click(); await history.getByText('新副本目录已复制', { exact: true }).waitFor();
    assert.equal(await app!.evaluate(({ clipboard }) => clipboard.readText()), destination);
    await history.getByTestId('history-archive').click(); await history.getByTestId('history-archive-result').waitFor();
    const archiveFile = await history.getByTestId('history-archive-result').locator('code').first().textContent(); assert.ok(archiveFile);
    const archiveBytes = await fs.readFile(archiveFile!), zip = await JSZip.loadAsync(archiveBytes);
    const archiveManifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    assert.equal(archiveManifest.kind, 'material-history-archive'); assert.equal(archiveManifest.projectId, id); assert.equal(archiveManifest.id, originalHistory.id);
    for (const [name, expectedHash] of Object.entries(await tree(oldFolder))) assert.equal(digest(await zip.file(`files/${name.split(path.sep).join('/')}`)!.async('nodebuffer')), expectedHash);
    const archiveComplete = JSON.parse(await fs.readFile(path.join(path.dirname(archiveFile!), '完成清单.json'), 'utf8'));
    assert.equal(archiveComplete.sha256, digest(archiveBytes));
    assert.deepEqual(await tree(canonical), currentBefore); assert.deepEqual(await fs.readFile(stateFile), stateBefore);
    assert.deepEqual(await tree(path.join(book, '小说资料/创作资料同步')), transportBefore);
    await history.getByTestId('history-archive-path').click(); await history.getByText('历史ZIP路径已复制', { exact: true }).waitFor();
    assert.equal(await app!.evaluate(({ clipboard }) => clipboard.readText()), archiveFile);
    await page.screenshot({ path: path.join(fixture, 'history-copy.png') });
    // Reopen the old version, then change the current file externally: the preview is stale.
    await history.getByTestId('history-refresh').click(); await selectOriginal();
    const notesFile = path.join(canonical, '创作笔记.md'), notes = parseNotesMarkdown(await fs.readFile(notesFile, 'utf8'), id);
    await fs.writeFile(notesFile, notesMarkdown({ ...notes, world: '外部最新设定保留。' }));
    const copiesBefore = await fs.readdir(path.join(book, '小说资料/资料历史恢复'));
    await history.getByTestId('history-copy').click(); await history.getByTestId('history-error').filter({ hasText: '变化' }).waitFor();
    await page.waitForFunction(() => {
      const error = document.querySelector('[data-testid="history-error"]')?.getBoundingClientRect();
      const panel = document.querySelector('[data-testid="history-panel"]')?.getBoundingClientRect();
      return error && panel && error.top >= panel.top && error.bottom <= panel.bottom;
    });
    assert.deepEqual(await fs.readdir(path.join(book, '小说资料/资料历史恢复')), copiesBefore);
    assert.equal(parseNotesMarkdown(await fs.readFile(notesFile, 'utf8'), id).world, '外部最新设定保留。');
    await history.locator('[data-testid="history-file"][data-path="筹备草稿.txt"]').click();
    await history.getByText('未能读取文件预览，请重新选择文件或刷新版本。', { exact: true }).first().waitFor();
    assert.equal(await history.getByText('正在读取文件预览…', { exact: true }).count(), 0);
    await page.screenshot({ path: path.join(fixture, 'history-stale.png') });
    await history.getByTestId('history-close').click();
    // Browsing history must retain a conflict choice already made in the outer panel.
    const latestB = await b.readNotes(id); await b.saveNotes(id, { ...latestB.value, world: 'B端并行设定，不应自动采纳。' }, latestB.hash);
    await second.synchronize({ projectId: id }); await panel.getByTestId('material-sync-refresh').click();
    const localChoice = panel.locator('[data-testid="material-sync-local"][data-path="创作笔记.md"]');
    await localChoice.click(); assert.equal(await localChoice.getAttribute('aria-pressed'), 'true');
    await panel.getByTestId('history-open').click(); await history.getByTestId('history-version').first().waitFor();
    await page.keyboard.press('Escape'); await history.waitFor({ state: 'detached' });
    assert.equal(await localChoice.getAttribute('aria-pressed'), 'true');
    await panel.getByTestId('history-open').click(); await selectOriginal();
    await history.getByTestId('history-close').click(); assert.equal(await localChoice.getAttribute('aria-pressed'), 'true');
    await panel.getByTestId('material-sync-run').click(); await panel.getByTestId('material-sync-result').waitFor();
    await panel.getByTestId('material-sync-close').click();
    assert.deepEqual(await fs.readFile(path.join(book, chapter.path)), manuscript);
    // A second project must never display the first project's history or copies.
    const another = path.join(fixture, '独立第二本'); await fs.mkdir(another); await openBook(another);
    await page.getByTestId('material-sync-open').click(); await panel.locator('.material-sync-history summary').click(); await panel.getByTestId('history-open').click();
    await history.getByTestId('history-empty').waitFor(); assert.equal(await history.getByTestId('history-version').count(), 0); await closeHistory();
    await exit(); await launch(); await openBook(); await page.getByRole('button', { name: '世界观', exact: true }).click();
    assert.equal(await page.locator('#project-note').inputValue(), '外部最新设定保留。');
    await page.locator('.chapter-list button').filter({ hasText: chapter.path }).click(); await page.locator('.tiptap').waitFor();
    assert.ok((await page.locator('.tiptap p').first().textContent())?.startsWith('\u3000\u3000'));
    assert.deepEqual(await fs.readFile(path.join(book, chapter.path)), manuscript); await exit(); assert.deepEqual(errors, []);
    await fs.writeFile(path.join(fixture, 'result.json'), JSON.stringify({ passed: true, projectId: id, originalRevision: originalHistory.id, directory: destination, checks: ['history UI and full file preview', 'dirty note retained', 'byte-identical independent copy', 'canonical/state/history preserved', 'busy close/exit blocked', 'clipboard directory', 'stale fingerprint refused', 'outer conflict selection retained', 'two-project isolation', 'DOCX unchanged and real U+3000', 'save-exit and reopen'] }, null, 2));
    console.log(`Material history desktop passed. Evidence: ${fixture}`);
  } finally { if (app) await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
