import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--exe' && path.isAbsolute(args[1]!)),
    'Usage: tsx tests/update-desktop.ts [--exe <absolute win-unpacked exe>]');
  const executable = args.length ? path.resolve(args[1]!) : createRequire(import.meta.url)('electron') as string;
  const archive = args.length ? path.join(path.dirname(executable), 'resources/app.asar') : null;
  if (archive) {
    const stat = await fs.lstat(archive);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), '打包版 app.asar 必须是普通文件');
  }
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/update-desktop-050-'));
  const expectedVersion = (JSON.parse(await fs.readFile('package.json', 'utf8')) as { version: string }).version;
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'app-data');
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: executable, args: archive ? [] : [path.resolve('out/main/index.js')], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    if (archive) {
      const identity = await app.evaluate(({ app: instance }) => ({ packaged: instance.isPackaged, path: instance.getAppPath(), version: instance.getVersion() }));
      assert.equal(identity.packaged, true, '必须执行实际打包版');
      assert.equal(identity.version, expectedVersion, '打包版版本必须与 package.json 一致');
      assert.equal(path.relative(await fs.realpath(archive), await fs.realpath(identity.path)), '', '必须执行指定安装包内的 app.asar');
    }
    // Replace all update handlers: no network request or real browser is opened by this test.
    await app.evaluate(({ ipcMain }, version) => {
      const state = globalThis as any;
      state.__updateDesktop = { count: 0, opened: 0, mode: 'new', token: '', version };
      ipcMain.removeHandler('update:check');
      ipcMain.handle('update:check', async (_event, token) => {
        const test = (globalThis as any).__updateDesktop;
        test.count++; test.token = token;
        if (test.mode === 'error') throw new Error('无法访问私有仓库');
        if (test.mode === 'late') await new Promise<void>(resolve => { test.resolve = resolve; });
        return { currentVersion: test.version, latestVersion: test.mode === 'same' ? test.version : '0.1.1-beta.99', updateAvailable: test.mode !== 'same', releaseUrl: 'https://github.com/FeiYi-od/novel-writer-desktop/releases/tag/v0.1.1-beta.99' };
      });
      ipcMain.removeHandler('update:open-page');
      ipcMain.handle('update:open-page', () => { (globalThis as any).__updateDesktop.opened++; });
    }, expectedVersion);
    const panel = page.getByTestId('update-panel');
    const open = async () => { await page.getByTestId('update-open').click(); await panel.waitFor(); };
    const close = async () => { await panel.getByRole('button', { name: '关闭', exact: true }).click(); await panel.waitFor({ state: 'detached' }); };
    await open();
    await page.waitForFunction(() => {
      const text = document.querySelector('[data-testid="update-current-version"]')?.textContent?.trim();
      return Boolean(text && text !== '读取中…');
    });
    const current = await panel.getByTestId('update-current-version').innerText();
    assert.equal(current, expectedVersion, '开发态应显示应用版本，而非 Electron 运行时版本');
    assert.match(await panel.innerText(), /浏览器中已登录 GitHub 不会自动授权程序/u);
    assert.equal(await panel.getByTestId('update-token').getAttribute('type'), 'password');
    await panel.getByTestId('update-token').fill('fake-session-credential');
    await panel.getByTestId('update-check').click();
    await panel.getByTestId('update-result').filter({ hasText: '发现新版本' }).waitFor();
    assert.equal(await panel.getByTestId('update-token').inputValue(), '');
    let state = await app.evaluate(() => (globalThis as any).__updateDesktop);
    assert.equal(state.token, 'fake-session-credential'); assert.equal(state.count, 1); assert.equal(state.opened, 0);
    await panel.getByTestId('update-open-page').click();
    await page.waitForTimeout(50);
    state = await app.evaluate(() => (globalThis as any).__updateDesktop);
    assert.equal(state.opened, 1);
    await close(); await open();
    assert.equal(await panel.getByTestId('update-token').inputValue(), '');
    await app.evaluate(() => { (globalThis as any).__updateDesktop.mode = 'same'; });
    await panel.getByTestId('update-check').click();
    await panel.getByTestId('update-result').filter({ hasText: '当前已是最新可用版本' }).waitFor();

    await app.evaluate(() => { (globalThis as any).__updateDesktop.mode = 'error'; });
    await panel.getByTestId('update-check').click();
    await panel.getByTestId('update-error').filter({ hasText: '无法访问私有仓库' }).waitFor();
    assert.equal(await panel.getByTestId('update-result').count(), 0);

    await app.evaluate(() => { (globalThis as any).__updateDesktop.mode = 'late'; });
    await panel.getByTestId('update-check').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="update-panel"]')?.getAttribute('aria-busy') === 'true');
    assert.equal(await panel.getByTestId('update-check').isDisabled(), true);
    await close(); await open();
    await app.evaluate(() => { const test = (globalThis as any).__updateDesktop; if (!test.resolve) throw new Error('模拟检查尚未开始'); test.resolve(); });
    await page.waitForTimeout(100);
    assert.equal(await panel.getByTestId('update-result').count(), 0, '关闭后的迟到结果不能写入新弹层');
    assert.equal(await panel.getByTestId('update-token').inputValue(), '');
    await page.screenshot({ path: path.join(fixture, 'update-panel.png') });
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(fixture, 'result.json'), JSON.stringify({ currentVersion: current, scope: archive ? 'packaged' : 'development', checks: ['新版本', '已最新', '错误', '凭据清空', '忙期关闭与迟到结果', '显式打开模拟发布页'], errors }, null, 2));
    console.log(`Update desktop passed: ${fixture}`);
  } finally {
    await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {});
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
