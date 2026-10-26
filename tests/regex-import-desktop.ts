import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Workspace } from '../src/main/workspace';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function tree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: string) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      assert.equal(item.isSymbolicLink(), false);
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await visit(file);
      else { assert.ok(item.isFile()); result[path.relative(root, file)] = digest(await fs.readFile(file)); }
    }
  }
  await visit(root); return result;
}
async function directories(root: string) {
  try { return (await fs.readdir(root)).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/regex-import-desktop-043-'));
  const first = path.join(fixture, 'A/虚构同名社区小说'), second = path.join(fixture, 'B/虚构同名社区小说');
  await fs.mkdir(first, { recursive: true }); await fs.mkdir(second, { recursive: true });
  const userData = path.join(fixture, 'profile'), materials = path.join(userData, '创作资料');
  const workspace = new Workspace(userData, materials); await workspace.initialize();
  const project = await workspace.attach(first), other = await workspace.attach(second);
  await workspace.readNotes(project.id); await workspace.readNotes(other.id);
  const chapter = await workspace.createChapter(project.id, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '\u3000\u3000虚构原稿不能被社区正则导入或预览改写。' }] }] });
  const manuscriptFile = path.join(first, chapter.path), manuscript = await fs.readFile(manuscriptFile);
  const active = path.join(first, '小说资料/正则脚本.json'), sourceRoot = path.join(first, '小说资料/正则导入原件');
  const oldRaw = Buffer.from(JSON.stringify({ schemaVersion: 1, projectId: project.id, scripts: [{ findRegex: '/old/g', replaceString: '旧' }] }, null, 2).replace(/\n/gu, '\r\n') + '\r\n');
  await fs.writeFile(active, oldRaw);
  const htmlField = '<img src=x onerror="window.__communityExecuted=true">';
  const single = { id: randomUUID(), scriptName: '虚构社区单条', findRegex: '/cat/gi', replaceString: '猫', trimStrings: [], disabled: false,
    placement: [1, 2], promptOnly: true, minDepth: 2, customExtension: { text: '<script>window.__communityExecuted=true</script>', draft: '\u3000\u3000未知字段必须按原字节保留。' }, [htmlField]: '只显示字段名' };
  const singleBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(single, null, 4).replace(/\n/gu, '\r\n') + '\r\n')]);
  const singleFile = path.join(fixture, '社区单条.json'); await fs.writeFile(singleFile, singleBytes);
  const bulkFile = path.join(fixture, '社区批量.json'), wrapperFile = path.join(fixture, '本书包装.json');
  const bulkBytes = Buffer.from(JSON.stringify([{ findRegex: '/cat/gi', replaceString: '猫' }, { findRegex: '/dog/g', replaceString: '犬' }]));
  const wrapperBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, projectId: project.id, scripts: [{ find_regex: '/cat/gi', replace_string: '喵' }], annotation: { retained: '原始包装扩展' } }, null, 2));
  await fs.writeFile(bulkFile, bulkBytes); await fs.writeFile(wrapperFile, wrapperBytes);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null; let page!: Page;
  const errors: string[] = [], checks: string[] = [];
  const modal = () => page.getByTestId('macro-panel');
  const report = () => modal().getByTestId('macro-import-result');
  const launch = async () => {
    app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [path.resolve('out/main/index.js')], env: { ...env, NOVEL_WRITER_TEST_DATA: userData } });
    page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  };
  const openBook = async (folder = first) => {
    await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByText(`已打开「${path.basename(folder)}」· ${folder === first ? 1 : 0} 个正文文件`, { exact: false }).first().waitFor();
  };
  const openPanel = async () => {
    await page.getByTestId('macro-open').click(); await modal().waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="macro-panel"]')?.getAttribute('aria-busy') === 'false');
  };
  const closePanel = async () => { await modal().getByTestId('macro-close').click(); await modal().waitFor({ state: 'detached' }); };
  const importFile = async (file: string | null) => {
    await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: selected === null, filePaths: selected === null ? [] : [selected] }); }, file);
    await modal().getByTestId('macro-import').click();
    await modal().getByTestId('macro-message').filter({ hasText: file ? '已导入' : '已取消导入' }).waitFor();
    if (file) await report().waitFor();
  };
  const verifySource = async (expected: Buffer, id: string, format: string, count: number) => {
    const file = await report().getByTestId('macro-import-source').textContent(); assert.ok(file);
    const book = id === project.id ? first : second;
    const relative = path.relative(path.join(book, '小说资料/正则导入原件'), file);
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative));
    assert.deepEqual(await fs.readFile(file), expected);
    const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(file), 'manifest.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.kind, 'regex-import-source'); assert.equal(manifest.projectId, id);
    assert.equal(manifest.file, '原始正则.json'); assert.equal(manifest.bytes, expected.length); assert.equal(manifest.sha256, digest(expected));
    assert.equal(manifest.format, format); assert.equal(manifest.scripts, count);
    await report().getByText(`SHA-256 ${digest(expected)}`, { exact: true }).waitFor();
    return { file, manifest };
  };
  const preview = async (expected: string) => {
    await modal().getByLabel('宏角色名').fill('星澄'); await modal().getByLabel('宏测试文本').fill('{{char}} cat CAT');
    await modal().getByTestId('macro-preview').click(); await modal().locator('.macro-result pre').nth(1).waitFor();
    assert.deepEqual(await modal().locator('.macro-result pre').allTextContents(), ['星澄 cat CAT', expected]);
  };
  const exitNormally = async () => {
    const closed = app!.waitForEvent('close', { timeout: 30000 });
    await page.getByRole('button', { name: '保存并退出', exact: true }).click(); await closed; app = null;
  };
  try {
    await launch(); await openBook(); await openPanel();
    const canonicalBefore = await tree(path.join(materials, project.id));
    await importFile(singleFile); await report().getByRole('heading', { name: '已识别：单条脚本 · 1 条', exact: true }).waitFor();
    const preserved = await verifySource(singleBytes, project.id, 'single', 1);
    await report().getByTestId('macro-import-unsupported').locator('summary').click();
    const unsupportedText = await report().getByTestId('macro-import-unsupported').textContent();
    assert.ok(unsupportedText?.includes('placement')); assert.ok(unsupportedText?.includes('promptOnly')); assert.ok(unsupportedText?.includes('customExtension'));
    assert.equal(await report().locator('img,script').count(), 0);
    assert.equal(await page.evaluate(() => (window as any).__communityExecuted ?? false), false);
    await preview('星澄 猫 猫');
    const singleActive = JSON.parse(await fs.readFile(active, 'utf8'));
    assert.equal(singleActive.projectId, project.id); assert.equal(singleActive.scripts.length, 1);
    assert.equal(singleActive.scripts[0].findRegex, single.findRegex); assert.equal(singleActive.scripts[0].placement, undefined);
    const history = path.join(first, '小说资料/正则脚本历史');
    assert.ok((await Promise.all((await fs.readdir(history)).map(name => fs.readFile(path.join(history, name))))).some(bytes => bytes.equals(oldRaw)));
    assert.deepEqual(await fs.readFile(manuscriptFile), manuscript); assert.deepEqual(await tree(path.join(materials, project.id)), canonicalBefore);
    await report().getByTestId('macro-import-copy-source').click(); await modal().getByText('原始JSON路径已复制', { exact: true }).waitFor();
    assert.equal(await app!.evaluate(({ clipboard }) => clipboard.readText()), preserved.file);
    await page.screenshot({ path: path.join(fixture, 'regex-import-single.png') });
    checks.push('社区单条对象、BOM/CRLF及未知扩展原字节/源清单哈希、原raw历史备份、手工预览与HTML字段名纯文本、路径复制');

    await importFile(bulkFile); await report().getByRole('heading', { name: '已识别：脚本数组 · 2 条', exact: true }).waitFor();
    await verifySource(bulkBytes, project.id, 'array', 2); await preview('星澄 猫 猫');
    await importFile(wrapperFile); await report().getByRole('heading', { name: '已识别：scripts 包装 · 1 条', exact: true }).waitFor();
    await verifySource(wrapperBytes, project.id, 'scripts', 1); await preview('星澄 喵 喵');
    assert.deepEqual(await fs.readFile(singleFile), singleBytes); assert.deepEqual(await fs.readFile(bulkFile), bulkBytes); assert.deepEqual(await fs.readFile(wrapperFile), wrapperBytes);
    const activeBefore = await fs.readFile(active), sourcesBefore = await tree(sourceRoot), sourceNames = await directories(sourceRoot);
    await importFile(null); assert.equal(await report().count(), 0);
    assert.deepEqual(await fs.readFile(active), activeBefore); assert.deepEqual(await directories(sourceRoot), sourceNames);
    checks.push('批量与scripts包装/旧别名仍可预览，原始选中文件保持，取消不创建新原件或更改活动脚本');

    await app!.evaluate(({ ipcMain }, result) => {
      const state = globalThis as any, channel = 'macros:import'; state.__originalRegexImportHandler = (ipcMain as any)._invokeHandlers.get(channel);
      ipcMain.removeHandler(channel); ipcMain.handle(channel, async () => result);
    }, { schemaVersion: 1, projectId: other.id, count: 2, format: 'single', unsupportedFields: ['placement'], unsupportedFieldCount: 1, sourceFile: preserved.file, sourceSha256: digest(singleBytes) });
    await modal().getByTestId('macro-import').click(); await modal().getByTestId('macro-error').filter({ hasText: '不匹配' }).waitFor();
    assert.equal(await report().count(), 0); await modal().getByText('当前 1 条脚本', { exact: true }).waitFor();
    assert.deepEqual(await fs.readFile(active), activeBefore); assert.deepEqual(await tree(sourceRoot), sourcesBefore);
    await app!.evaluate(({ ipcMain }) => { const channel = 'macros:import'; ipcMain.removeHandler(channel); ipcMain.handle(channel, (globalThis as any).__originalRegexImportHandler); });
    checks.push('伪造错书导入响应不更新当前脚本数量或显示原件/复制入口');

    await closePanel(); await openBook(second); await openPanel();
    await modal().getByText('当前 0 条脚本', { exact: true }).waitFor(); assert.equal(await report().count(), 0);
    const otherCanonical = await tree(path.join(materials, other.id));
    await importFile(singleFile); const otherPreserved = await verifySource(singleBytes, other.id, 'single', 1);
    assert.notEqual(otherPreserved.file, preserved.file); await preview('星澄 猫 猫');
    const otherActive = JSON.parse(await fs.readFile(path.join(second, '小说资料/正则脚本.json'), 'utf8'));
    assert.equal(otherActive.projectId, other.id); assert.deepEqual(await tree(path.join(materials, other.id)), otherCanonical);
    assert.deepEqual(await fs.readFile(active), activeBefore); assert.deepEqual(await tree(sourceRoot), sourcesBefore);
    await page.screenshot({ path: path.join(fixture, 'regex-import-second-book.png') });
    await closePanel(); await exitNormally(); await launch(); await openBook(); await openPanel();
    await modal().getByText('当前 1 条脚本', { exact: true }).waitFor(); assert.equal(await report().count(), 0);
    await preview('星澄 喵 喵'); assert.deepEqual(await fs.readFile(active), activeBefore); assert.deepEqual(await tree(sourceRoot), sourcesBefore);
    assert.deepEqual(await fs.readFile(manuscriptFile), manuscript);
    await closePanel(); await page.locator('.chapter-list button').filter({ hasText: chapter.path }).click(); await page.locator('.tiptap').waitFor();
    assert.ok((await page.locator('.tiptap p').first().textContent())?.startsWith('\u3000\u3000'));
    await exitNormally(); assert.deepEqual(errors, []);
    checks.push('同名双书独立源副本/projectId、无跨书旧报告、保存退出重开和DOCX原字节/真实全角空格保留');
    await fs.writeFile(path.join(fixture, 'result.json'), JSON.stringify({ schemaVersion: 1, passed: true, projectId: project.id, otherProjectId: other.id, checks }, null, 2));
    console.log(`Regex import desktop passed. Evidence: ${fixture}`);
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(fixture, 'failure.png') }).catch(() => {});
      await fs.writeFile(path.join(fixture, 'failure-page.txt'), await page.locator('body').innerText().catch(() => '')).catch(() => {});
    }
    throw error;
  } finally { const pending = app as ElectronApplication | null; if (pending) await pending.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
