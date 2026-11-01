import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/usage-focus-desktop-'));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'data'); delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [path.resolve('out/main/index.js')], env });
  try {
    const page = await app.firstWindow();
    const open = page.getByRole('button', { name: '用量统计', exact: true });
    const more = page.getByText('更多功能', { exact: true });
    await more.click(); await open.click();
    const dialog = page.getByRole('dialog', { name: '用量统计' }); await dialog.waitFor();
    assert.equal(await dialog.evaluate(element => element === document.activeElement), true, '打开后焦点进入弹窗');
    for (const key of ['Tab', 'Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, '焦点不得进入遮罩后的控件');
    }
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
    assert.equal(await more.evaluate(element => element === document.activeElement), true, '关闭后恢复更多功能的焦点');
    await more.click(); await open.click(); await dialog.waitFor(); await dialog.getByRole('button', { name: '关闭' }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await more.evaluate(element => element === document.activeElement), true);
    console.log(`Usage modal keyboard desktop passed: ${fixture}`);
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
