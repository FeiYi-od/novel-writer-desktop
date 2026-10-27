import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  const fixture = path.resolve('.artifacts', `storage-compat-${Date.now()}`);
  const folder = path.join(fixture, '虚构目录兼容书');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.getByRole('heading', { name: '我的书架', exact: false }).waitFor();
    const invalidMessages = await page.evaluate(async () => {
      const inputs = [
        null, {}, [{ host: 'nas.example.test', port: 0 }], [{ host: 'https://nas.example.test', port: 443 }],
        Array.from({ length: 9 }, () => ({ host: 'nas.example.test', port: 443 })),
        [{ host: '127.0.0.1', port: 443 }, { host: 'bad host', port: 443 }],
      ];
      return Promise.all(inputs.map(async input => {
        try { await window.writer.probeNas(input as never); return ''; } catch (error) { return String(error); }
      }));
    });
    assert.ok(invalidMessages.every(message => message.length > 0), '主进程拒绝全部非法输入，不开始部分目标检查');
    await app.evaluate(({ ipcMain, dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
      ipcMain.removeHandler('nas:probe');
      (globalThis as any).__storageProbeCalls = [];
      ipcMain.handle('nas:probe', (_event, targets: { host: string; port: number; label?: string }[]) => {
        (globalThis as any).__storageProbeCalls.push(targets);
        return targets.map(target => ({ ...target, ok: true, ms: 0 }));
      });
    }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.waitForFunction(() => {
      const button = document.querySelector('[data-testid="material-sync-open"]');
      return button instanceof HTMLButtonElement && !button.disabled;
    });
    assert.equal(await page.getByTestId('nas-open').innerText(), '文件夹与备份…');
    await page.getByTestId('nas-open').click();
    const dialog = page.getByRole('dialog', { name: 'NAS 连接检查' });
    await dialog.waitFor();
    assert.equal(await dialog.getByLabel('NAS 目标', { exact: true }).inputValue(), '');
    assert.equal(await dialog.getByTestId('nas-probe').isDisabled(), true);
    const provider = dialog.getByLabel('存储方式', { exact: true });
    assert.equal(await provider.inputValue(), 'generic');
    const options = await provider.locator('option').allTextContents();
    for (const expected of ['群晖 Synology', '威联通 QNAP', '百度网盘', '迅雷云盘', 'OneDrive']) assert.ok(options.includes(expected));
    await provider.selectOption('baidu');
    assert.match(await dialog.getByTestId('storage-provider-guide').innerText(), /普通上传或自动备份不等于双向同步/u);
    await provider.selectOption('xunlei');
    assert.match(await dialog.getByTestId('storage-provider-guide').innerText(), /没有内置迅雷云盘登录/u);
    const guide = await dialog.getByTestId('storage-compatibility').innerText();
    assert.match(guide, /应用内 NAS \/ 网盘账户直连：未开放/u);
    assert.match(guide, /启用并完成本书“固定资料同步”/u);
    assert.match(guide, /完整传输小说文件夹，仅传 DOCX 不包含全部资料/u);
    assert.equal(await dialog.getByTestId('nas-backup').isEnabled(), true);
    assert.deepEqual(await app.evaluate(() => (globalThis as any).__storageProbeCalls), [], '选设备与打开面板不自动探测网络');
    const targets = dialog.getByLabel('NAS 目标', { exact: true });
    await targets.fill('nas.example.test:443\n\n[::1]:broken');
    await dialog.getByTestId('nas-target-error').waitFor();
    assert.match(await dialog.getByTestId('nas-target-error').innerText(), /第 3 行/u);
    assert.equal(await dialog.getByTestId('nas-probe').isDisabled(), true);
    assert.deepEqual(await app.evaluate(() => (globalThis as any).__storageProbeCalls), []);
    await targets.fill('nas.example.test:443\n[2001:db8::1]:8443\n::1');
    await dialog.getByTestId('nas-probe').click();
    await dialog.getByRole('cell', { name: '可达', exact: true }).first().waitFor();
    const calls = await app.evaluate(() => (globalThis as any).__storageProbeCalls);
    assert.deepEqual(calls, [[
      { host: 'nas.example.test', port: 443, label: 'nas.example.test:443' },
      { host: '2001:db8::1', port: 8443, label: '[2001:db8::1]:8443' },
      { host: '::1', port: 443, label: '::1' },
    ]]);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByTestId('nas-open').click();
    assert.equal(await page.getByLabel('NAS 目标', { exact: true }).inputValue(), '', '关闭重开不预填手工目标');
    assert.equal(await page.getByLabel('存储方式', { exact: true }).inputValue(), 'generic');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(fixture, 'storage-compat.png') });
    console.log('Storage compatibility desktop passed: empty private defaults, provider folder guides, explicit line errors, IPv6 IPC, no real network calls.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
