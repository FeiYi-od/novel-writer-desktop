import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R19-4: import SillyTavern regex scripts and preview macro expansion + script application.
async function main() {
  const fixture = path.resolve('.artifacts', `macro-desktop-${Date.now()}`), folder = path.join(fixture, '宏小说');
  await fs.mkdir(folder, { recursive: true });
  const scriptFile = path.join(fixture, 'regex.json');
  await fs.writeFile(scriptFile, JSON.stringify([
    { findRegex: '\\((.*?)\\)', replaceString: '（$1）', trimStrings: ['~~'] },
    { findRegex: '嗯', replaceString: '唔', disabled: true }
  ], null, 2), 'utf8');
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  const queue = [folder, scriptFile];
  try {
    await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.shift() ?? ''] }); }, queue);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    await page.getByTestId('macro-open').click();
    const dialog = page.getByRole('dialog', { name: '宏与正则' });
    await dialog.waitFor();
    await dialog.getByTestId('macro-import').click();
    await dialog.getByText(/已导入 2 条正则脚本/u).waitFor();
    await dialog.getByLabel('宏角色名').fill('林夏');
    await dialog.getByLabel('宏测试文本').fill('{{char}}说(小声)：{{user}}看见你了~~');
    await dialog.getByTestId('macro-preview').click();
    await dialog.getByText('套用正则后', { exact: true }).waitFor();
    const panes = await dialog.locator('.macro-result pre').allTextContents();
    assert.equal(panes[0], '林夏说(小声)：作者看见你了~~', `宏展开结果不符：${panes[0]}`);
    assert.equal(panes[1], '林夏说（小声）：作者看见你了~~', `正则应用结果不符（未匹配原文不可被trimStrings清除）：${panes[1]}`);
    console.log('Macro desktop passed: macros expanded and regex scripts applied in order.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
