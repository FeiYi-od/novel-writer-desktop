import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/world-array-desktop-'));
  const folder = path.join(fixture, '虚构数组书'), directory = path.join(folder, '小说资料', '世界书'); await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(folder, '正文.txt'), '虚构测试正文。');
  const file = path.join(directory, '数组世界.json');
  const original = { name: '数组世界', extensions: { plugin: '保留' }, entries: [{ comment: '虚构甲', key: ['甲'], content: '甲的设定' }, { comment: '虚构乙', key: ['乙'], content: '乙的设定' + '长'.repeat(400), unknown: { plugin: 1 } }, { comment: '虚构丙', key: ['丙'], content: '丙的设定' }] };
  const originalBytes = Buffer.from(JSON.stringify(original, null, 2)); await fs.writeFile(file, originalBytes);
  const args = process.argv.slice(2); assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--exe' && path.isAbsolute(args[1]!)));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: args.length ? args[1]! : createRequire(import.meta.url)('electron'), args: args.length ? [] : [path.resolve('out/main/index.js')], env });
  try {
    if (args.length) { const info = await app.evaluate(({app}) => ({ packaged: app.isPackaged, version: app.getVersion() })); assert.equal(info.packaged, true); assert.equal(info.version, JSON.parse(await fs.readFile('package.json', 'utf8')).version); }
    const page = await app.firstWindow(); page.setDefaultTimeout(30000); await page.setViewportSize({ width: 1000, height: 720 }); const dialogs: string[] = [];
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.accept(); });
    await app.evaluate(({dialog}, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click(); await page.getByText('已打开「虚构数组书」', { exact: false }).waitFor();
    await page.getByRole('button', { name: '世界观', exact: true }).click();
    const panel = page.getByRole('region', { name: '本书世界设定卡' });
    await panel.getByText('虚构乙', { exact: true }).click();
    await panel.getByRole('button', { name: '删除设定卡', exact: true }).click();
    await panel.getByText('设定卡已删除并备份，可从回收站恢复。').waitFor();
    assert.ok(dialogs.some(message => /后续条目的编号会移动/u.test(message)));
    const after = JSON.parse(await fs.readFile(file, 'utf8')); assert.deepEqual(after.entries, [original.entries[0], original.entries[2]]);
    const backups = await fs.readdir(path.join(folder, '小说资料', '世界书修改备份'));
    assert.ok((await Promise.all(backups.map(name => fs.readFile(path.join(folder, '小说资料', '世界书修改备份', name))))).some(bytes => bytes.equals(originalBytes)));
    await panel.getByRole('button', { name: '设定卡回收站…' }).click();
    const item = panel.locator('article').filter({ hasText: '虚构乙' }); await item.getByRole('button', { name: '恢复设定卡' }).waitFor();
    assert.equal(await item.getByRole('button', { name: '恢复设定卡' }).isEnabled(), true, '数组位置被后续条目占用不能被错误地当作同 ID 冲突');
    await item.getByRole('button', { name: '查看备份内容' }).click();
    await item.getByLabel('回收记录内容').getByText(/乙的设定/u).waitFor();
    assert.equal(await item.evaluate(element => element.scrollWidth > element.clientWidth), false, '长文本预览不能使卡片水平溢出');
    await item.screenshot({ path: path.join(fixture, 'world-trash-preview.png') });
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), after);
    after.entries[0].content = '外部的后续修改'; await fs.writeFile(file, JSON.stringify(after));
    await item.getByRole('button', { name: '恢复设定卡' }).click(); await panel.getByRole('alert').getByText(/数组条目在删除后发生变化/u).waitFor();
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).entries[0].content, '外部的后续修改');
    await item.getByRole('button', { name: '追加为末尾新卡…' }).click(); await panel.getByText('已将「虚构乙」追加为末尾设定卡，备份保留。').waitFor();
    const appended = JSON.parse(await fs.readFile(file, 'utf8')); assert.equal(appended.entries[0].content, '外部的后续修改'); assert.deepEqual(appended.entries[2], original.entries[1]);
    assert.ok(dialogs.some(message => /编号和原位置可能不同/u.test(message)));
    await item.getByRole('button', { name: '追加为末尾新卡…' }).click(); await panel.getByRole('alert').getByText(/相同内容的条目/u).waitFor();
    after.entries[0].content = '甲的设定'; await fs.writeFile(file, JSON.stringify(after));
    await item.getByRole('button', { name: '恢复设定卡' }).click(); await panel.getByText('已恢复「虚构乙」，备份保留。').waitFor();
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), original);
    await item.getByRole('button', { name: '永久清理回收记录…' }).click();
    await panel.getByText('已清理「虚构乙」的回收记录，世界书和其他备份保留。').waitFor();
    assert.ok(dialogs.some(message => /清理后不能再从此记录恢复/u.test(message)));
    assert.equal(await item.count(), 0); assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), original);
    assert.ok((await fs.readdir(path.join(folder, '小说资料', '世界书修改备份'))).length > 0);
    console.log('World array desktop passed: warning, backup, safe conflict rejection, restoration at original index and extension preservation.');
  } finally { await app.evaluate(({app}) => app.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
