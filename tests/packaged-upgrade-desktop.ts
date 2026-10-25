import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { emptyCharacter } from '../src/core/characters';

// A bounded packaged-code upgrade simulation. No installer is run, no installed application
// is replaced, and NOVEL_WRITER_TEST_DATA is deliberately absent. Both runtimes and all data
// are isolated. NSIS upgrade/uninstall hooks need a separate installer acceptance check.
const runtimeFiles = [
  '小说编写器.exe', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll',
  'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'icudtl.dat', 'LICENSE.electron.txt',
  'LICENSES.chromium.html', 'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin',
  'version', 'vk_swiftshader_icd.json', 'vk_swiftshader.dll', 'vulkan-1.dll'
];
const resources = ['app.asar', 'app.asar.unpacked', 'default_app.asar', 'elevate.exe', 'protect-upgrade-materials.ps1'];
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return path.resolve(value);
};

async function assertRegularTree(source: string) {
  const stat = await fs.lstat(source);
  assert.ok(!stat.isSymbolicLink(), 'Runtime fixture must not traverse a link');
  if (stat.isDirectory()) for (const name of await fs.readdir(source)) await assertRegularTree(path.join(source, name));
  else assert.ok(stat.isFile(), 'Runtime fixture must contain regular files');
}

async function copyRuntime(sourceExe: string, destination: string) {
  const source = path.dirname(sourceExe);
  await fs.mkdir(destination, { recursive: true });
  // An explicit list excludes the real install's 创作资料 and uninstaller. Copies are not
  // hardlinks: later overlaying the new runtime cannot mutate the installed beta.1 files.
  for (const relative of [...runtimeFiles, 'locales', ...resources.map(name => path.join('resources', name))]) {
    const from = path.join(source, relative), to = path.join(destination, relative);
    try { await assertRegularTree(from); }
    catch (error) {
      if (missing(error) && !['小说编写器.exe', 'resources/app.asar', 'resources\\app.asar'].includes(relative)) continue;
      throw error;
    }
    await fs.cp(from, to, { recursive: true, force: true, dereference: false });
  }
  assert.deepEqual(await fs.readFile(path.join(destination, 'resources', 'app.asar')), await fs.readFile(path.join(source, 'resources', 'app.asar')));
}

async function files(root: string, relative = ''): Promise<string[]> {
  const result: string[] = [];
  for (const name of await fs.readdir(path.join(root, relative))) {
    const entry = path.join(relative, name), stat = await fs.lstat(path.join(root, entry));
    assert.ok(!stat.isSymbolicLink(), 'Data fixture must not traverse a link');
    if (stat.isDirectory()) result.push(...await files(root, entry));
    else { assert.ok(stat.isFile()); result.push(entry); }
  }
  return result.sort();
}

async function main() {
  assert.equal(process.platform, 'win32', 'This packaged upgrade simulation requires Windows');
  const newVersion = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8')).version as string;
  assert.match(newVersion, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u, 'Expected a concrete package version');
  const local = process.env.LOCALAPPDATA;
  assert.ok(local, 'LOCALAPPDATA is required');
  const oldExe = argument('--old-exe') ?? path.join(local, 'Programs', 'NovelWriterDesktop', '小说编写器.exe');
  const newExe = argument('--new-exe') ?? path.join(local, 'NovelWriterBuild', 'win-unpacked', '小说编写器.exe');
  await fs.access(oldExe); await fs.access(newExe);
  const id = randomUUID();
  const fixture = path.join(local, 'NovelWriterUpgradeChecks', id);
  const evidence = path.resolve('.artifacts', `packaged-upgrade-${newVersion}-${id}`);
  await fs.mkdir(evidence, { recursive: true }); await fs.mkdir(fixture, { recursive: true });
  const runtime = path.join(fixture, 'runtime'), executable = path.join(runtime, '小说编写器.exe');
  const profile = path.join(fixture, 'profile'), isolatedLocal = path.join(fixture, 'local-app-data');
  const folder = path.join(fixture, '虚构升级验收');
  await fs.mkdir(folder); await fs.mkdir(isolatedLocal);
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.LOCALAPPDATA = isolatedLocal;
  delete env.ELECTRON_RUN_AS_NODE; delete env.NOVEL_WRITER_TEST_DATA;
  let app: ElectronApplication | undefined; let page!: Page;
  const errors: string[] = [];
  const launch = async (version: string) => {
    app = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${profile}`], env, timeout: 40000 });
    page = await app.firstWindow({ timeout: 35000 }); page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => void dialog.accept());
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).waitFor();
    const identity = await app.evaluate(({ app: instance }) => ({ version: instance.getVersion(), data: instance.getPath('userData'), packaged: instance.isPackaged }));
    assert.equal(identity.version, version); assert.equal(path.resolve(identity.data), profile); assert.equal(identity.packaged, true);
  };
  const open = async () => {
    await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByText('已打开「虚构升级验收」', { exact: false }).first().waitFor();
  };
  const exit = async () => {
    const closed = app!.waitForEvent('close', { timeout: 30000 });
    await page.getByRole('button', { name: '保存并退出', exact: true }).click();
    await closed; app = undefined;
  };
  const modelName = '升级验收本机模型', modelKey = 'upgrade-fixture-credential-only';
  const world = '仅用于升级验收：虚构星港依靠月光运行。';
  const paragraph = '这是虚构升级验收正文，原稿字节必须保留。';
  try {
    await copyRuntime(oldExe, runtime); await launch('0.1.1-beta.1'); await open();
    const project = (await page.evaluate(() => window.writer.listProjects()))[0];
    assert.equal(project.root, await fs.realpath(folder));
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节', exact: true }).click();
    await page.locator('.tiptap').fill(paragraph);
    await page.getByRole('button', { name: '保存 DOCX', exact: true }).click();
    await page.getByText('DOCX 已保存到所选文件夹', { exact: true }).waitFor();
    await page.getByRole('button', { name: '世界观', exact: true }).click();
    await page.locator('#project-note').fill(world);
    await page.getByRole('button', { name: '保存本书资料', exact: true }).click();
    await page.getByText('本书资料已保存', { exact: true }).waitFor();
    await page.evaluate(async payload => {
      const cards = await window.writer.readCharacters(payload.projectId);
      await window.writer.saveCharacter(payload.projectId, { fields: payload.fields, enabled: true }, cards.hash);
      const models = await window.writer.aiConnections();
      await window.writer.saveAIConnection({ name: payload.modelName, baseUrl: 'http://127.0.0.1:9/v1', model: 'fixture-model', adapter: 'generic', thinking: 'default', timeoutSeconds: 300,
        contextWindow: 32768, maxOutputTokens: 4096, tokenParameter: 'max_tokens', apiKey: payload.modelKey }, models.hash);
      const timeline = await window.writer.readTimeline(payload.projectId);
      await window.writer.saveTimeline(payload.projectId, [{ id: payload.entryId, when: '第1天', title: '虚构星港启航', note: '旧版按书名保存的资料' }], timeline.hash);
    }, { projectId: project.id, fields: { ...emptyCharacter(), name: '升级验收领航员', description: '临时虚构角色，不是真实小说资料' }, modelName, modelKey, entryId: randomUUID() });
    const oldLocation = await page.evaluate(projectId => window.writer.materialLocation(projectId), project.id);
    assert.equal(path.resolve(oldLocation), await fs.realpath(path.join(runtime, '创作资料', project.id)));
    await exit();

    const chapters = (await fs.readdir(folder)).filter(file => file.endsWith('.docx'));
    assert.equal(chapters.length, 1);
    const chapter = chapters[0], manuscriptBefore = await fs.readFile(path.join(folder, chapter));
    const canonicalBefore = new Map<string, Buffer>();
    for (const name of await files(oldLocation)) canonicalBefore.set(name, await fs.readFile(path.join(oldLocation, name)));
    assert.ok(canonicalBefore.has('创作笔记.md')); assert.ok(canonicalBefore.has('人物卡.md'));
    const legacyFile = path.join(fixture, '创作资料', '时间线-虚构升级验收.json');
    const legacyBefore = await fs.readFile(legacyFile);
    assert.equal(JSON.parse(legacyBefore.toString('utf8')).projectId, project.id);
    const modelFile = path.join(profile, 'ai-connections.json'), modelsBefore = await fs.readFile(modelFile);
    assert.ok(!modelsBefore.toString('utf8').includes(modelKey));
    assert.ok(JSON.parse(modelsBefore.toString('utf8')).connections[0].encryptedKey);

    // Runtime overlay preserves the old app-adjacent directory. This is deliberately not
    // described as executing the installer: its pre-uninstall backup hook is separate.
    await copyRuntime(newExe, runtime); await launch(newVersion);
    const projects = await page.evaluate(() => window.writer.listProjects());
    assert.deepEqual(projects.map(item => item.id), [project.id]); await open();
    const stableLocation = await page.evaluate(projectId => window.writer.materialLocation(projectId), project.id);
    assert.equal(path.resolve(stableLocation), await fs.realpath(path.join(profile, '创作资料', project.id)));
    for (const [name, bytes] of canonicalBefore) assert.deepEqual(await fs.readFile(path.join(stableLocation, name)), bytes, `Canonical migration changed ${name}`);
    for (const [name, bytes] of canonicalBefore) assert.deepEqual(await fs.readFile(path.join(oldLocation, name)), bytes, `Old canonical source changed ${name}`);
    const receiptFile = path.join(profile, 'material-upgrade-state.json'), receiptBefore = await fs.readFile(receiptFile);
    const receipt = JSON.parse(receiptBefore.toString('utf8')) as { schemaVersion: number; backupDirectory: string; files: number };
    assert.equal(receipt.schemaVersion, 1); assert.ok(receipt.files >= canonicalBefore.size);
    const backupRoot = await fs.realpath(path.join(profile, 'material-upgrade-backups'));
    assert.ok((await fs.realpath(receipt.backupDirectory)).startsWith(backupRoot + path.sep));
    for (const [name, bytes] of canonicalBefore) assert.deepEqual(await fs.readFile(path.join(receipt.backupDirectory, 'files', project.id, name)), bytes, `Upgrade backup changed ${name}`);
    await page.getByRole('button', { name: '世界观', exact: true }).click();
    assert.equal(await page.locator('#project-note').inputValue(), world);
    const inspected = await page.evaluate(async projectId => ({ cards: await window.writer.readCharacters(projectId), timeline: await window.writer.readTimeline(projectId), models: await window.writer.aiConnections() }), project.id);
    assert.deepEqual(inspected.cards.value.cards.map(card => card.name), ['升级验收领航员']);
    assert.deepEqual(inspected.timeline.entries.map(entry => entry.title), ['虚构星港启航']);
    assert.equal(inspected.models.connections[0].name, modelName); assert.equal(inspected.models.connections[0].keyState, 'ok');
    assert.ok(!JSON.stringify(inspected.models).includes(modelKey)); assert.ok(!JSON.stringify(inspected.models).includes('encryptedKey'));
    assert.deepEqual(await fs.readFile(modelFile), modelsBefore);
    assert.deepEqual(await fs.readFile(legacyFile), legacyBefore);
    assert.deepEqual(await fs.readFile(path.join(folder, '小说资料', '时间线.json')), legacyBefore);
    assert.deepEqual(await fs.readFile(path.join(folder, chapter)), manuscriptBefore);
    await page.locator('.chapter-list button').filter({ hasText: chapter }).click();
    await page.locator('.tiptap').waitFor(); assert.ok((await page.locator('.tiptap').innerText()).includes(paragraph));
    const copy = await page.locator('.tiptap p').first().textContent(); assert.ok(copy?.startsWith('\u3000\u3000'));
    await page.getByTestId('material-sync-open').click();
    const panel = page.getByTestId('material-sync-panel'); await panel.getByTestId('material-sync-toggle').click();
    await panel.getByTestId('material-sync-run').click(); await panel.getByTestId('material-sync-result').waitFor();
    // Verify the newly packaged history UI without restoring or altering author data.
    await panel.locator('.material-sync-history summary').click(); await panel.getByTestId('history-open').click();
    const history = page.getByTestId('history-panel');
    await history.getByTestId('history-version').first().click();
    await history.locator('[data-testid="history-file"][data-path="创作笔记.md"]').click();
    await history.locator('.material-history-side pre').filter({ hasText: world }).first().waitFor();
    assert.equal(await history.getByTestId('history-archive').isDisabled(), false);
    await page.screenshot({ path: path.join(evidence, `${newVersion}-history-preview.png`) });
    await history.getByTestId('history-close').click();
    await page.screenshot({ path: path.join(evidence, `${newVersion}-upgrade-sync.png`) });
    await panel.getByTestId('material-sync-close').click(); await exit();
    const transport = path.join(folder, '小说资料', '创作资料同步');
    for (const name of await files(transport)) {
      assert.ok(!/(?:ai-connections|auxiliary-models|detection-connections|library\.json|\.sqlite|\.db)$/iu.test(name), 'Account data must not be transported');
      const bytes = await fs.readFile(path.join(transport, name));
      assert.ok(!bytes.includes(Buffer.from(modelKey)), 'Plain credential leaked into transport');
      assert.ok(!bytes.includes(Buffer.from(modelName)), 'Model settings leaked into transport');
      assert.ok(!bytes.includes(Buffer.from(JSON.parse(modelsBefore.toString('utf8')).connections[0].encryptedKey)), 'Encrypted credential leaked into transport');
    }
    await launch(newVersion); await open();
    assert.equal((await page.evaluate(() => window.writer.listProjects()))[0].id, project.id);
    await page.getByRole('button', { name: '世界观', exact: true }).click(); assert.equal(await page.locator('#project-note').inputValue(), world);
    assert.deepEqual(await fs.readFile(path.join(folder, chapter)), manuscriptBefore);
    assert.deepEqual(await fs.readFile(receiptFile), receiptBefore, 'A repeat startup must retain the existing successful migration receipt'); await exit();
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify({ schemaVersion: 1, passed: true, scope: 'isolated packaged runtime overlay, not NSIS installer execution', oldVersion: '0.1.1-beta.1', newVersion, projectId: project.id,
      checks: ['packaged app without NOVEL_WRITER_TEST_DATA', 'isolated existing profile', 'stable materials migration with retained source', 'immutable upgrade backup and repeat-start receipt', 'legacy named JSON byte-preserving migration', 'project identity and DOCX bytes', 'real U+3000 copied text', 'encrypted local model configuration survives', 'packaged history preview and archive action available', 'transport excludes credentials and settings', 'save-exit and restart'], manuscriptSha256: hash(manuscriptBefore), fixture }, null, 2));
    console.log(`Packaged upgrade simulation passed. Evidence: ${evidence}`);
  } finally { if (app) await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
