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
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--exe' && path.isAbsolute(args[1]!)),
    'Usage: tsx tests/material-history-capacity-desktop.ts [--exe <absolute win-unpacked exe>]');
  const executable = args.length ? path.resolve(args[1]!) : createRequire(import.meta.url)('electron') as string;
  const archive = args.length ? path.join(path.dirname(executable), 'resources/app.asar') : null;
  if (archive) { const stat = await fs.lstat(archive); assert.ok(stat.isFile() && !stat.isSymbolicLink()); }
  const version = JSON.parse(await fs.readFile('package.json','utf8')).version as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/material-history-capacity-045-'));
  const first = path.join(fixture, 'A/虚构同名容量小说'), second = path.join(fixture, 'B/虚构同名容量小说');
  await fs.mkdir(first, { recursive: true }); await fs.mkdir(second, { recursive: true });
  const userData = path.join(fixture, 'profile'), materials = path.join(userData, '创作资料');
  const workspace = new Workspace(userData, materials); await workspace.initialize();
  const project = await workspace.attach(first), other = await workspace.attach(second);
  await workspace.readNotes(project.id); await workspace.readNotes(other.id);
  // Opening the writer normally creates these empty Markdown stores. Initialize
  // them before the preservation baseline so the history test measures its own operations.
  const characters = new CharacterStore(id => workspace.getProject(id), materials);
  const library = new LibraryStore(id => workspace.getProject(id), materials);
  for (const id of [project.id, other.id]) { await characters.read(id); await library.read(id); }
  const service = new MaterialSyncService(workspace, materials, userData);
  await service.configure(project.id, false); await service.configure(other.id, false);
  const chapter = await workspace.createChapter(project.id, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '\u3000\u3000虚构容量验收正文，统计与归档不能改写。' }] }] });
  const manuscriptFile = path.join(first, chapter.path), manuscript = await fs.readFile(manuscriptFile);
  const canonical = path.join(materials, project.id), canonicalBefore = await tree(canonical);
  const stateFile = path.join(userData, 'material-sync', `${project.id}.json`), stateBefore = await fs.readFile(stateFile);
  const historyId = randomUUID(), historyFolder = path.join(materials, '同步历史', project.id, historyId);
  await fs.mkdir(historyFolder, { recursive: true }); await fs.writeFile(path.join(historyFolder, '旧设定.txt'), '虚构旧设定保留为未确认草稿。');
  const localBefore = await tree(historyFolder);
  const versions = path.join(first, '小说资料/创作资料同步/版本'); await fs.mkdir(versions, { recursive: true });
  const initialIds = Array.from({ length: 800 }, () => randomUUID());
  await Promise.all(initialIds.map(id => fs.mkdir(path.join(versions, id))));
  // No committed manifest: these directories consume slots but must not become
  // verified history versions. Their payload is not needed to count capacity.
  const unfinished = path.join(versions, initialIds[0]!, '未完成原件.json');
  const unfinishedBytes = Buffer.from('{ deliberately unfinished fictional payload'); await fs.writeFile(unfinished, unfinishedBytes);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null; let page!: Page;
  const errors: string[] = [], checks: string[] = [];
  const panel = () => page.getByTestId('history-panel');
  const outer = () => page.getByTestId('material-sync-panel');
  const launch = async () => {
    app = await electron.launch({ executablePath: executable, args: archive ? [] : [path.resolve('out/main/index.js')], env: { ...env, NOVEL_WRITER_TEST_DATA: userData } });
    if (archive) {
      const identity = await app.evaluate(({ app: instance }) => ({ packaged: instance.isPackaged, path: instance.getAppPath(), version: instance.getVersion() }));
      assert.equal(identity.packaged, true); assert.equal(identity.version, version);
      assert.equal(path.relative(await fs.realpath(archive), await fs.realpath(identity.path)), '', 'Must execute the supplied app.asar');
    }
    page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  };
  const openBook = async (folder = first) => {
    await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByText(`已打开「${path.basename(folder)}」· ${folder === first ? 1 : 0} 个正文文件`, { exact: false }).first().waitFor();
  };
  const settled = async () => {
    await page.waitForFunction(() => document.querySelector('[data-testid="history-panel"]')?.getAttribute('aria-busy') === 'false');
  };
  const openHistory = async () => {
    await page.getByTestId('material-sync-open').click(); await outer().locator('.material-sync-history summary').click(); await outer().getByTestId('history-open').click();
    await panel().waitFor(); await settled();
  };
  const refresh = async () => { await panel().getByTestId('history-refresh').click(); await settled(); };
  const closeHistory = async () => { await panel().getByTestId('history-close').click(); await outer().getByTestId('material-sync-close').click(); };
  const restoreCapacity = async () => {
    await app!.evaluate(({ ipcMain }) => {
      const state = globalThis as any, channel = 'materials-sync:history-capacity';
      ipcMain.removeHandler(channel); ipcMain.handle(channel, state.__capacityOriginal);
    });
  };
  const releaseCapacity = async () => {
    await app!.evaluate(async () => {
      const state = globalThis as any;
      for (let index = 0; index < 200 && typeof state.__capacityRelease !== 'function'; index++) await new Promise(resolve => setTimeout(resolve, 10));
      if (typeof state.__capacityRelease !== 'function') throw new Error('The controlled capacity request did not reach its handler');
      state.__capacityRelease(); state.__capacityRelease = undefined;
    });
  };
  const exit = async () => {
    const closed = app!.waitForEvent('close', { timeout: 30000 });
    await page.getByRole('button', { name: '保存并退出', exact: true }).click(); await closed; app = null;
  };
  try {
    await launch(); await openBook(); await openHistory();
    await panel().getByTestId('history-capacity-transport').filter({ hasText: '800' }).waitFor();
    assert.equal(await panel().getByTestId('history-capacity-transport').getAttribute('data-level'), 'warning');
    assert.equal(await panel().getByTestId('history-capacity-local').getAttribute('data-level'), 'normal');
    assert.equal(await panel().getByTestId('history-version').count(), 1);
    await panel().getByTestId('history-capacity').getByText(/不等于已核验版本数或磁盘占用/u).waitFor();
    await page.screenshot({ path: path.join(fixture, 'capacity-warning.png') });
    checks.push('真实800个未完成目录达到预警；完整历史列表仅含1份本机归档，未将目录数当作核验版本或磁盘占用');

    await Promise.all(Array.from({ length: 200 }, () => fs.mkdir(path.join(versions, randomUUID()))));
    await refresh();
    assert.equal(await panel().getByTestId('history-capacity-transport').getAttribute('data-level'), 'full');
    await panel().getByTestId('history-capacity-transport').getByText('剩余 0 个', { exact: true }).waitFor();
    await panel().locator(`[data-testid="history-version"][data-id="${historyId}"]`).click();
    await panel().locator('[data-testid="history-file"][data-path="旧设定.txt"]').click();
    await panel().locator('.material-history-side pre').filter({ hasText: '虚构旧设定保留' }).waitFor();
    assert.equal(await panel().getByTestId('history-copy').isEnabled(), true);
    assert.equal(await panel().getByTestId('history-archive').isEnabled(), true);
    await panel().getByTestId('history-copy').click(); await panel().getByTestId('history-result').waitFor();
    const copyDirectory = await panel().getByTestId('history-result').locator('code').textContent(); assert.ok(copyDirectory);
    assert.deepEqual(await tree(path.join(copyDirectory, 'files')), localBefore);
    await panel().getByTestId('history-archive').click(); await panel().getByTestId('history-archive-result').waitFor();
    assert.equal((await fs.readdir(versions)).length, 1000);
    await page.screenshot({ path: path.join(fixture, 'capacity-full-copy.png') });
    checks.push('真实1000满额仍能只读对照、恢复为新副本与打包ZIP，未清理任何目录或释放名额');

    await fs.mkdir(path.join(versions, randomUUID())); await refresh();
    await panel().getByTestId('history-error').filter({ hasText: /1000|1,000/u }).waitFor();
    await panel().getByTestId('history-capacity-transport').filter({ hasText: '至少 1,001' }).waitFor();
    assert.equal(await panel().getByTestId('history-capacity-transport').getAttribute('data-level'), 'over-limit');
    assert.equal(await panel().getByTestId('history-version').count(), 1);
    await page.screenshot({ path: path.join(fixture, 'capacity-over-limit.png') });
    checks.push('真实1001目录导致列表拒绝时，独立容量仍显示至少1001和超限；旧列表保留而不伪报成功');

    await app!.evaluate(({ ipcMain }) => {
      const state = globalThis as any, channel = 'materials-sync:history-capacity';
      state.__capacityOriginal = (ipcMain as any)._invokeHandlers.get(channel); ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async () => { throw new Error('虚构容量读取失败'); });
    });
    await refresh(); await panel().getByTestId('history-capacity-error').filter({ hasText: '虚构容量读取失败' }).waitFor();
    assert.equal(await panel().getByTestId('history-capacity-transport').count(), 0);
    assert.equal(await panel().getByTestId('history-version').count(), 1);
    await restoreCapacity();
    // A forged response may arrive from a stale transport; strict book/schema and
    // boundary checks must reject it instead of keeping an old healthy card.
    for (const mutation of [{ projectId: other.id }, { schemaVersion: 2 }, { transport: { entries: 3, exact: true, remaining: 997, level: 'full' } }]) {
      await app!.evaluate(({ ipcMain }, change) => {
        const state = globalThis as any, channel = 'materials-sync:history-capacity'; ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (event, ...args) => ({ ...await state.__capacityOriginal(event, ...args), ...change }));
      }, mutation);
      await refresh(); await panel().getByTestId('history-capacity-error').filter({ hasText: '不匹配' }).waitFor();
      assert.equal(await panel().getByTestId('history-capacity-transport').count(), 0);
      assert.equal(await panel().getByTestId('history-version').count(), 1);
    }
    await restoreCapacity(); await refresh();
    await app!.evaluate(({ ipcMain }) => {
      const state = globalThis as any, channel = 'materials-sync:history-capacity'; ipcMain.removeHandler(channel);
      state.__capacityRelease = undefined;
      ipcMain.handle(channel, async (event, ...args) => {
        await new Promise<void>(resolve => { state.__capacityRelease = resolve; });
        return state.__capacityOriginal(event, ...args);
      });
    });
    await panel().getByTestId('history-refresh').click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="history-close"]') as HTMLButtonElement)?.disabled === true);
    assert.equal(await panel().getByTestId('history-refresh').isDisabled(), true);
    await page.waitForFunction(() => (Array.from(document.querySelectorAll('button')).find(button => button.textContent === '保存并退出') as HTMLButtonElement)?.disabled === true);
    await page.keyboard.press('Escape'); assert.equal(await panel().count(), 1);
    await page.keyboard.press('Tab'); assert.equal(await panel().evaluate(element => element.contains(document.activeElement)), true);
    await releaseCapacity(); await settled(); await restoreCapacity();
    checks.push('容量读取失败、错书、未知schema及矛盾边界均独立拒绝，不清空旧列表；等待期间重复/关闭/退出和键盘焦点受控');

    await closeHistory(); await openBook(second); await openHistory();
    assert.equal(await panel().getByTestId('history-capacity-local').getAttribute('data-level'), 'normal');
    await panel().getByTestId('history-capacity-transport').getByText('剩余 1,000 个', { exact: true }).waitFor();
    await panel().getByTestId('history-empty').waitFor(); assert.equal(await panel().getByTestId('history-version').count(), 0);
    await app!.evaluate(({ ipcMain }, firstId) => {
      const state = globalThis as any, channel = 'materials-sync:history-capacity';
      state.__capacityOriginal = (ipcMain as any)._invokeHandlers.get(channel); state.__capacityRelease = undefined; ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, ...args) => {
        await new Promise<void>(resolve => { state.__capacityRelease = resolve; });
        const value = await state.__capacityOriginal(event, ...args); return { ...value, projectId: firstId };
      });
    }, project.id);
    await panel().getByTestId('history-refresh').click();
    await releaseCapacity(); await settled();
    await panel().getByTestId('history-capacity-error').filter({ hasText: '不匹配' }).waitFor();
    assert.equal(await panel().getByTestId('history-capacity-transport').count(), 0);
    assert.equal(await panel().getByTestId('history-version').count(), 0);
    await restoreCapacity(); await closeHistory(); await exit();
    await launch(); await openBook(); await openHistory();
    assert.equal(await panel().getByTestId('history-capacity-transport').getAttribute('data-level'), 'over-limit');
    await closeHistory(); await page.locator('.chapter-list button').filter({ hasText: chapter.path }).click(); await page.locator('.tiptap').waitFor();
    assert.ok((await page.locator('.tiptap p').first().textContent())?.startsWith('\u3000\u3000'));
    await exit(); assert.deepEqual(errors, []);
    assert.deepEqual(await fs.readFile(manuscriptFile), manuscript); assert.deepEqual(await tree(canonical), canonicalBefore);
    assert.deepEqual(await tree(historyFolder), localBefore); assert.deepEqual(await fs.readFile(stateFile), stateBefore);
    assert.deepEqual(await fs.readFile(unfinished), unfinishedBytes); assert.equal((await fs.readdir(versions)).length, 1001);
    assert.equal((await fs.readdir(path.join(first, '小说资料/资料历史恢复'))).length, 1);
    assert.equal((await fs.readdir(path.join(first, '小说资料/资料历史归档'))).length, 1);
    checks.push('同名双书容量与列表独立、延迟错书响应拒绝；保存退出重开及原稿/canonical/state/历史原字节和可复制双U+3000保留');
    await fs.writeFile(path.join(fixture, 'result.json'), JSON.stringify({ schemaVersion: 1, passed: true, version,
      scope: archive ? 'packaged app.asar capacity UI, isolated fictional TEST_DATA profile; not NSIS or upgrade' : 'development build, isolated fictional TEST_DATA profile',
      projectId: project.id, otherProjectId: other.id, checks }, null, 2));
    console.log(`Material history capacity desktop passed. Evidence: ${fixture}`);
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(fixture, 'failure.png') }).catch(() => {});
      await fs.writeFile(path.join(fixture, 'failure-page.txt'), await page.locator('body').innerText().catch(() => '')).catch(() => {});
    }
    throw error;
  } finally { const pending = app as ElectronApplication | null; if (pending) await pending.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
