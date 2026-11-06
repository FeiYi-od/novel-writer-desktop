import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/world-merge-desktop-'));
  const folder = path.join(fixture, '虚构合并书'), directory = path.join(folder, '小说资料', '世界书'); await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(folder, '正文.txt'), '虚构测试正文。');
  const file = path.join(directory, '虚构世界.json');
  const original = { name: '虚构世界', extensions: { plugin: '根扩展' }, entries: {
    '1': { comment: '备份港口', key: ['旧港'], content: '备份中的港口设定。', extensions: { plugin: '备份扩展' } },
    '2': { comment: '现有港口', key: ['新港'], content: '当前的港口设定。', extensions: { plugin: '现有扩展' } },
    '3': { comment: '其他地点', key: ['山'], content: '其他设定。' }
  } };
  await fs.writeFile(file, JSON.stringify(original, null, 2));
  const args = process.argv.slice(2); assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--exe' && path.isAbsolute(args[1]!)));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: args.length ? args[1]! : createRequire(import.meta.url)('electron'), args: args.length ? [] : [path.resolve('out/main/index.js')], env });
  try {
    if (args.length) { const info = await app.evaluate(({app}) => ({ packaged: app.isPackaged, version: app.getVersion() })); assert.equal(info.packaged, true); assert.equal(info.version, JSON.parse(await fs.readFile('package.json', 'utf8')).version); }
    const page = await app.firstWindow(); page.setDefaultTimeout(30000); await page.setViewportSize({ width: 1000, height: 720 }); page.on('dialog', dialog => void dialog.accept());
    await app.evaluate(({dialog}, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click(); await page.getByText('已打开「虚构合并书」', { exact: false }).waitFor();
    await page.getByRole('button', { name: '世界观', exact: true }).click(); const panel = page.getByRole('region', { name: '本书世界设定卡' });
    await panel.getByText('备份港口', { exact: true }).click(); await panel.getByRole('button', { name: '删除设定卡', exact: true }).click();
    await panel.getByText('设定卡已删除并备份，可从回收站恢复。').waitFor(); await panel.getByRole('button', { name: '设定卡回收站…' }).click();
    const item = panel.locator('article').filter({ hasText: '备份港口' }); await item.getByRole('button', { name: '比较并合并到现有卡…' }).click();
    let modal = page.getByRole('dialog', { name: '比较并合并设定卡' }); await modal.getByLabel('合并目标设定卡').selectOption('2');
    assert.equal(await modal.getByRole('button', { name: '确认合并' }).isDisabled(), true); await modal.getByLabel('正文使用备份').check();
    const outside = JSON.parse(await fs.readFile(file, 'utf8')); outside.entries['2'].content = '外部新修改。'; await fs.writeFile(file, JSON.stringify(outside));
    await modal.getByRole('button', { name: '确认合并' }).click(); await modal.getByRole('alert').getByText(/世界书已在外部变化/u).waitFor();
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).entries['2'].content, '外部新修改。');
    await modal.getByRole('button', { name: '关闭', exact: true }).click(); await panel.getByRole('button', { name: '刷新', exact: true }).click();
    await panel.getByText('现有港口', { exact: true }).waitFor();
    await item.getByRole('button', { name: '比较并合并到现有卡…' }).click(); modal = page.getByRole('dialog', { name: '比较并合并设定卡' });
    await modal.getByLabel('合并目标设定卡').selectOption('2'); await modal.getByLabel('正文使用备份').check();
    await modal.getByText('外部新修改。', { exact: true }).waitFor(); await modal.getByText('备份中的港口设定。', { exact: true }).waitFor();
    assert.equal(await modal.evaluate(element => element.scrollWidth > element.clientWidth), false);
    assert.equal(await modal.evaluate(element => { const box = element.getBoundingClientRect(), footer = element.querySelector('footer')!.getBoundingClientRect(); return footer.bottom <= box.bottom && footer.bottom <= window.innerHeight; }), true, '确认按钮应始终位于窗口内');
    await modal.focus(); await page.keyboard.press('Shift+Tab'); assert.equal(await modal.getByRole('button', { name: '确认合并' }).evaluate(element => document.activeElement === element), true);
    await page.keyboard.press('Tab'); assert.equal(await modal.getByRole('button', { name: '关闭', exact: true }).evaluate(element => document.activeElement === element), true);
    await modal.screenshot({ path: path.join(fixture, 'merge-dialog.png') });
    await modal.getByRole('button', { name: '确认合并' }).click(); await panel.getByText('已合并「备份港口」的所选字段，原世界书和回收备份保留。').waitFor();
    const result = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(result.entries['2'].comment, '现有港口'); assert.equal(result.entries['2'].content, '备份中的港口设定。'); assert.deepEqual(result.entries['2'].key, ['新港']);
    assert.deepEqual(result.entries['2'].extensions, { plugin: '现有扩展' }); assert.deepEqual(result.entries['3'], original.entries['3']); assert.deepEqual(result.extensions, original.extensions);
    assert.equal((await fs.readdir(path.join(folder, '小说资料', '世界设定卡回收站'))).filter(name => name.endsWith('.json')).length, 1);
    console.log('World trash merge desktop passed: explicit per-field comparison, stale world protection, backups and extension preservation.');
  } finally { await app.evaluate(({app}) => app.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
