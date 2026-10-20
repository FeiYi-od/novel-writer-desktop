import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R14c-5: saved keys are reported as usable, and the panel exposes a backup-based recovery path.
async function main() {
  const fixture = path.resolve('.artifacts', `key-status-desktop-${Date.now()}`), folder = path.join(fixture, '密钥小说');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    // 先保存一个连接（真实 safeStorage 加密），再保存第二个把上一份写成备份
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByLabel('快捷配置').selectOption({ label: 'DeepSeek' });
    await page.getByLabel('深度思考').selectOption('disabled');
    await page.getByLabel('API 基础地址', { exact: true }).fill('http://127.0.0.1:1/v1');
    await page.getByLabel('连接名称', { exact: true }).fill('主模型甲');
    await page.getByLabel('模型名称', { exact: true }).fill('mock-key');
    await page.getByLabel('API 密钥', { exact: true }).fill('test-only-key-value');
    await page.getByRole('button', { name: '保存模型连接', exact: true }).click();
    await page.getByText('模型连接已保存', { exact: true }).waitFor();
    // 再保存一次：第二次写入会让上一份连接文件变成 .backup，供恢复使用
    await page.getByRole('button', { name: '保存模型连接', exact: true }).click();
    await page.getByText('模型连接已保存', { exact: true }).waitFor();
    await page.getByRole('button', { name: '写作空间', exact: true }).click();
    await page.getByTestId('keys-open').click();
    const dialog = page.getByRole('dialog', { name: '密钥状态' });
    await dialog.waitFor();
    const rows = await dialog.locator('.key-table tbody tr').allTextContents();
    assert.ok(rows.length >= 1, `应至少列出一个连接：${rows.join(' | ')}`);
    assert.ok(rows.every(row => row.includes('密钥可用')), `真实保存的密钥应可解密：${rows.join(' | ')}`);
    const recover = dialog.getByTestId('keys-recover');
    assert.equal(await recover.isDisabled(), false, '第二次保存后应存在可用备份，恢复按钮可点');
    const report = await page.evaluate(async () => window.writer.keyStatus());
    assert.ok(report.backupUsable, '备份应可用');
    // 明文密钥不得出现在连接文件与备份里
    const files = await fs.readdir(path.join(fixture, 'app-data'), { recursive: true, withFileTypes: true });
    const json = files.filter(entry => entry.isFile() && entry.name.startsWith('ai-connections'));
    assert.ok(json.length >= 1, '应存在连接文件');
    for (const file of json) {
      const text = await fs.readFile(path.join((file as unknown as { parentPath: string }).parentPath, file.name), 'utf8');
      assert.ok(!text.includes('test-only-key-value'), '连接文件里不能出现明文密钥');
    }
    console.log('Key status desktop passed: keys report as usable, backup recoverable, no plaintext on disk.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
