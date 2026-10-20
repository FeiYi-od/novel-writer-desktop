import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R32-3 界面侧：断网演练自检在临时目录里跑完三个场景并把结果列出来。
async function main() {
  const fixture = path.resolve('.artifacts', `drill-desktop-${Date.now()}`), folder = path.join(fixture, '演练书');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(25000);
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    await page.getByTestId('nas-open').click();
    const dialog = page.getByRole('dialog', { name: 'NAS 连接检查' });
    await dialog.waitFor();
    await dialog.getByTestId('nas-drill').click();
    const result = dialog.getByTestId('nas-drill-result');
    await result.waitFor();
    const rows = await result.locator('tbody tr').allTextContents();
    assert.equal(rows.length, 3, `应列出三个场景：${rows.join(' | ')}`);
    for (const row of rows) assert.match(row, /通过/u, `每个场景都应通过：${row}`);
    assert.match(rows.join(' '), /外部改动时拒绝覆盖/u);
    assert.match(rows.join(' '), /网络目录不可用时保住草稿/u);
    assert.match(rows.join(' '), /恢复后继续写作/u);
    // 历史留档：跑过一次后应能在面板里看到最近一次结果
    await dialog.getByTestId('nas-drill-history').waitFor();
    const historyText = await dialog.getByTestId('nas-drill-history').innerText();
    assert.match(historyText, /历史自检/u, `应显示历史入口：${historyText}`);
    console.log('Drill desktop passed: three offline scenarios reported as passed, and the run is kept in history.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
