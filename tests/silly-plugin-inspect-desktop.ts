import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

async function main() {
  const exeArg = process.argv.indexOf('--exe');
  const exePath = exeArg < 0 ? null : process.argv[exeArg + 1];
  if (exeArg >= 0 && (!exePath || !path.isAbsolute(exePath))) throw new Error('打包版 exe 路径必须是绝对路径');
  const executable = exePath ? path.resolve(exePath) : createRequire(import.meta.url)('electron') as string;
  const expectedVersion = JSON.parse(await fs.readFile('package.json', 'utf8')).version as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/plugin-desktop-055-'));
  const book = path.join(fixture, '虚构小说'), plugin = path.join(fixture, '虚构插件');
  await fs.mkdir(book); await fs.mkdir(plugin);
  const manifest = JSON.stringify({ display_name: '虚构插件', version: '1.0', js: 'index.js', hooks: { activate: 'init' }, requires: ['mock'] });
  const source = 'globalThis.__PLUGIN_SHOULD_NOT_RUN = true; throw new Error("不应执行插件");';
  await fs.writeFile(path.join(plugin, 'manifest.json'), manifest);
  await fs.writeFile(path.join(plugin, 'index.js'), source);
  await fs.writeFile(path.join(plugin, 'LICENSE'), '虚构测试许可');
  const communityArg = process.argv.indexOf('--community');
  const community = communityArg < 0 ? null : path.join(fixture, '社区插件');
  if (community) {
    const supplied = process.argv[communityArg + 1]; if (!supplied || supplied.startsWith('--')) throw new Error('缺少社区插件参考目录');
    await fs.mkdir(community);
    for (const file of ['manifest.json', 'index.js', 'LICENSE']) await fs.copyFile(path.join(path.resolve(supplied), file), path.join(community, file));
    assert.equal(createHash('sha256').update(await fs.readFile(path.join(community, 'index.js'))).digest('hex'), '3ae3e3ffee4aaf8a52f1de74d2f5ac01fdae2650eb881d66a5fbb99d64d0a3f0');
  }
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'app-data'); delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: executable, args: exePath ? [] : [path.resolve('out/main/index.js')], env });
  if (exePath) {
    const identity = await app.evaluate(({ app: instance }) => ({ packaged: instance.isPackaged, version: instance.getVersion(), path: instance.getAppPath() }));
    assert.equal(identity.packaged, true); assert.equal(identity.version, expectedVersion);
    assert.equal(await fs.realpath(identity.path), await fs.realpath(path.join(path.dirname(executable), 'resources/app.asar')));
  }
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, book);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    await page.getByTestId('world-open').click();
    const world = page.getByRole('dialog', { name: '世界书' }); await world.waitFor();
    await world.getByTestId('plugin-inspect-open').click();
    const panel = page.getByRole('dialog', { name: '酒馆插件兼容检查' }); await panel.waitFor();
    const invalid = await page.evaluate(async () => { try { await window.writer.inspectSillyPlugin(crypto.randomUUID()); return false; } catch { return true; } });
    assert.equal(invalid, true, '未知小说不能打开文件选择器或获得结果');
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
      (dialog as any).showMessageBoxSync = () => { (globalThis as any).__pluginClosePrompt = true; return 0; };
      const fs = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises');
      const original = fs.open;
      (fs as any).open = async (...args: any[]) => {
        if (String(args[0]).endsWith('manifest.json')) {
          (fs as any).open = original; (globalThis as any).__pluginReadStarted = true;
          await new Promise<void>(resolve => { (globalThis as any).__pluginResumeRead = resolve; });
        }
        return (original as any)(...args);
      };
    }, plugin);
    await panel.getByTestId('plugin-inspect-select').click();
    for (let attempt = 0; attempt < 100 && !await app.evaluate(() => Boolean((globalThis as any).__pluginReadStarted)); attempt++) await page.waitForTimeout(30);
    assert.equal(await app.evaluate(() => Boolean((globalThis as any).__pluginReadStarted)), true);
    assert.equal(await panel.getByRole('button', { name: '关闭', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('button.save-exit').isDisabled(), true);
    assert.equal(await page.locator('[aria-label="世界书"]').evaluate(el => el.closest('.modal-overlay')?.hasAttribute('inert')), true);
    await panel.focus(); await page.keyboard.press('Escape');
    assert.equal(await panel.count(), 1, '检查期间 Escape 不得关闭面板');
    await page.locator('[aria-label="世界书"] > footer button').evaluate((button: HTMLElement) => button.click());
    assert.equal(await panel.count(), 1);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await page.waitForTimeout(100); assert.equal(page.isClosed(), false);
    assert.equal(await app.evaluate(() => Boolean((globalThis as any).__pluginClosePrompt)), true);
    await app.evaluate(() => (globalThis as any).__pluginResumeRead());
    const report = panel.getByTestId('plugin-inspect-report'); await report.waitFor();
    const shown = await report.innerText();
    assert.match(shown, /虚构插件/); assert.match(shown, /未执行插件/); assert.match(shown, /index\.js（存在）/);
    assert.doesNotMatch(shown, /不应执行插件/); assert.ok(!shown.includes(fixture));
    assert.equal(await page.evaluate(() => typeof (globalThis as any).__PLUGIN_SHOULD_NOT_RUN), 'undefined');
    assert.equal(await fs.readFile(path.join(plugin, 'index.js'), 'utf8'), source);
    assert.equal(await fs.readFile(path.join(plugin, 'manifest.json'), 'utf8'), manifest);
    await page.screenshot({ path: path.join(fixture, 'report.png') });
    if (community) {
      await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, community);
      await panel.getByTestId('plugin-inspect-select').click();
      await report.getByText(/Lorem Ipsum/u).waitFor();
      assert.match(await report.innerText(), /未执行插件/u);
    }
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
    await panel.getByTestId('plugin-inspect-select').click();
    await report.waitFor();
    await panel.getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal(await world.count(), 1);
    console.log(`Plugin inspection desktop passed: ${fixture}`);
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
