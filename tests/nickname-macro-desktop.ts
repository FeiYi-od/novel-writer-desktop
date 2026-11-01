import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--exe' && path.isAbsolute(args[1]!)), 'Usage: tsx tests/nickname-macro-desktop.ts [--exe <absolute packaged exe>]');
  const executable = args.length ? path.resolve(args[1]!) : createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/nickname-desktop-059-'));
  const first = path.join(fixture, '甲虚构书'), second = path.join(fixture, '乙虚构书');
  await fs.mkdir(first); await fs.mkdir(second);
  const source = path.join(fixture, '虚构脚本.json');
  await fs.writeFile(source, JSON.stringify([{ findRegex: '/#/g', replaceString: '{{charFull}}/{{charNickname}}/{{char}}' }]));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'app-data'); delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: executable, args: args.length ? [] : [path.resolve('out/main/index.js')], env });
  if (args.length) {
    const expectedVersion = JSON.parse(await fs.readFile('package.json', 'utf8')).version as string;
    const identity = await app.evaluate(({ app: instance }) => ({ packaged: instance.isPackaged, version: instance.getVersion(), path: instance.getAppPath() }));
    assert.equal(identity.packaged, true); assert.equal(identity.version, expectedVersion);
    assert.equal(await fs.realpath(identity.path), await fs.realpath(path.join(path.dirname(executable), 'resources/app.asar')));
  }
  const page = await app.firstWindow(); page.setDefaultTimeout(25000); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const queue = [first, source, second];
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected.shift() ?? ''] }); }, queue);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click(); await page.getByTestId('macro-open').click();
    const panel = page.getByTestId('macro-panel'); await panel.waitFor();
    await panel.getByTestId('macro-import').click(); await panel.getByText(/已导入 1 条正则脚本/u).waitFor();
    await panel.getByLabel('宏角色名').fill('林岚');
    const text = '{{userFull}}|{{charFull}}|{{userNickname}}|{{charNickname}}|{{user}}|{{char}}|#';
    await panel.getByLabel('宏测试文本').fill(text);
    const preview = async () => {
      await panel.getByTestId('macro-preview').click(); await panel.locator('.macro-result pre').first().waitFor();
      return panel.locator('.macro-result pre').allTextContents();
    };
    assert.deepEqual(await preview(), ['{{userFull}}|{{charFull}}|{{userNickname}}|{{charNickname}}|作者|林岚|#', '{{userFull}}|{{charFull}}|{{userNickname}}|{{charNickname}}|作者|林岚|{{charFull}}/{{charNickname}}/林岚']);
    await panel.getByText('社区昵称宏 · 单次预览', { exact: true }).click();
    assert.equal(await panel.getByLabel('启用昵称宏预览').isChecked(), false);
    await panel.getByLabel('启用昵称宏预览').check();
    await panel.getByLabel('宏作者原名').fill('作者甲'); await panel.getByLabel('宏作者昵称').fill('阿甲'); await panel.getByLabel('宏角色昵称').fill('小岚');
    assert.deepEqual(await preview(), ['作者甲|林岚|阿甲|小岚|作者甲|林岚|#', '作者甲|林岚|阿甲|小岚|作者甲|林岚|林岚/小岚/林岚']);
    await panel.getByLabel('基础名称宏使用昵称').check();
    assert.deepEqual(await preview(), ['作者甲|林岚|阿甲|小岚|阿甲|小岚|#', '作者甲|林岚|阿甲|小岚|阿甲|小岚|林岚/小岚/小岚']);
    await page.screenshot({ path: path.join(fixture, 'nickname-preview.png') });
    await panel.getByLabel('宏角色昵称').fill('   ');
    assert.deepEqual(await preview(), ['作者甲|林岚|阿甲|林岚|阿甲|林岚|#', '作者甲|林岚|阿甲|林岚|阿甲|林岚|林岚/林岚/林岚']);
    await panel.getByLabel('启用昵称宏预览').uncheck();
    assert.deepEqual(await preview(), ['{{userFull}}|{{charFull}}|{{userNickname}}|{{charNickname}}|作者|林岚|#', '{{userFull}}|{{charFull}}|{{userNickname}}|{{charNickname}}|作者|林岚|{{charFull}}/{{charNickname}}/林岚']);
    await panel.getByTestId('macro-close').click(); await panel.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click(); await page.getByTestId('macro-open').click();
    await panel.waitFor(); await panel.getByText('社区昵称宏 · 单次预览', { exact: true }).click();
    assert.equal(await panel.getByLabel('启用昵称宏预览').isChecked(), false, '第二本书默认关闭且不读取第一本昵称');
    await panel.getByLabel('宏角色名').fill('乙角色'); await panel.getByLabel('宏测试文本').fill('{{charNickname}}/{{char}}');
    assert.deepEqual(await preview(), ['{{charNickname}}/乙角色', '{{charNickname}}/乙角色']);
    assert.deepEqual(errors, []);
    console.log(`Nickname macro desktop passed: ${fixture}`);
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
