import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Source-aligned data fixtures only: no upstream plugin execution, real novels or models.
async function main() {
  const fixture = path.resolve('.artifacts', `regex-compat-desktop-${randomUUID()}`);
  const first = path.join(fixture, '第一本虚构书'), second = path.join(fixture, '第二本虚构书');
  await fs.mkdir(first, { recursive: true }); await fs.mkdir(second);
  const scriptFile = path.join(fixture, 'regex.json');
  await fs.writeFile(scriptFile, JSON.stringify([
    { findRegex: '/\\[(.*?)\\]/g', replaceString: '{{match}}|$1|$<missing>', trimStrings: ['~'] },
    { findRegex: '/cat/gi', replaceString: '猫' },
    { findRegex: '/外/g', replaceString: '错误', disabled: true },
    { findRegex: '/cat/gg', replaceString: '错误' }
  ]), 'utf8');
  const require = createRequire(import.meta.url);
  const env = { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  try {
    const queue = [first, scriptFile];
    await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.shift() ?? ''] }); }, queue);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    await page.getByTestId('macro-open').click();
    const modal = page.getByRole('dialog', { name: '宏与正则' });
    await modal.getByTestId('macro-import').click();
    await modal.getByText('已导入 4 条正则脚本', { exact: true }).waitFor();
    await modal.getByLabel('宏角色名').fill('林岚');
    await modal.getByLabel('宏测试文本').fill('[~~{{char}}~~] ~~外~~ cat CAT');
    await modal.getByTestId('macro-preview').click();
    await modal.locator('.macro-result pre').nth(1).waitFor();
    assert.deepEqual(await modal.locator('.macro-result pre').allTextContents(), [
      '[~~林岚~~] ~~外~~ cat CAT', '[林岚]|林岚| ~~外~~ 猫 猫'
    ]);
    const disk = JSON.parse(await fs.readFile(path.join(first, '小说资料', '正则脚本.json'), 'utf8'));
    assert.equal(disk.schemaVersion, 1);
    assert.equal(disk.scripts[0].findRegex, '/\\[(.*?)\\]/g');
    assert.equal(disk.scripts[0].trimStrings[0], '~');
    await modal.getByRole('button', { name: '关闭', exact: true }).click();
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, second);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByTestId('macro-open').click();
    await modal.getByText('当前 0 条脚本', { exact: true }).waitFor();
    await modal.getByLabel('宏测试文本').fill('[~~原文~~] cat CAT');
    await modal.getByTestId('macro-preview').click();
    await modal.locator('.macro-result pre').nth(1).waitFor();
    assert.equal(await modal.locator('.macro-result pre').nth(1).textContent(), '[~~原文~~] cat CAT');
    await assert.rejects(fs.access(path.join(second, '小说资料', '正则脚本.json')));
    await page.screenshot({ path: path.join(fixture, 'regex-second-book.png') });
    console.log('Regex compatibility desktop passed: slash flags, capture-only trim, macro replacement, disabled/invalid scripts and book isolation.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
