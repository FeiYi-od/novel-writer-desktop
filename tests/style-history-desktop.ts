import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R25b-3: styles keep rule versions; recording an effect and restoring an old version both work.
async function main() {
  const fixture = path.resolve('.artifacts', `style-history-desktop-${Date.now()}`), folder = path.join(fixture, '版本小说');
  await fs.mkdir(folder, { recursive: true });
  const corpus = path.join(fixture, '语料.txt');
  await fs.writeFile(corpus, '雨落下来。他站着不动。'.repeat(60), 'utf8');
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  const queue = [folder, corpus];
  try {
    await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.shift() ?? ''] }); }, queue);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    // 用本机统计学习建立一份文风（不调模型）。
    await page.getByRole('button', { name: '文风研习室', exact: true }).click();
    await page.getByRole('button', { name: '＋ 导入文本', exact: true }).click();
    await page.getByRole('button', { name: '刷新', exact: true }).click().catch(() => {});
    await page.locator('.source-list input[type="checkbox"]').first().check();
    await page.getByLabel('文风名称', { exact: true }).fill('冷峻');
    await page.getByRole('button', { name: '分析并生成文风', exact: true }).click();
    await page.locator('.style-card h3', { hasText: '冷峻' }).first().waitFor();
    // 把规则改一版，制造历史版本。
    await page.getByRole('button', { name: '编辑规则', exact: true }).first().click();
    await page.getByLabel('写作规则').fill('短句为主，少形容词，动作推进。');
    await page.getByRole('button', { name: '保存文风', exact: true }).click();
    await page.getByRole('button', { name: '写作空间', exact: true }).click();
    await page.getByTestId('style-history-open').click();
    const dialog = page.getByRole('dialog', { name: '文风版本与效果' });
    await dialog.waitFor();
    const before = await page.evaluate(async () => (await window.writer.readStyleHistory((await window.writer.listProjects())[0].id)).entries.map(entry => ({ version: entry.current.version, history: entry.history.length, effects: entry.effects.length })));
    assert.equal(before.length, 1);
    assert.ok(before[0].version >= 2, `改过规则后版本应 >= 2，实际 ${before[0].version}`);
    assert.ok(before[0].history >= 1, '旧规则应进入历史');
    await page.getByTestId('record-effect').click();
    await page.getByText('已记录一次效果样本', { exact: true }).waitFor();
    const recorded = await page.evaluate(async () => (await window.writer.readStyleHistory((await window.writer.listProjects())[0].id)).entries[0].effects.length);
    assert.equal(recorded, 1);
    await dialog.locator('details').first().click();
    await page.getByTestId('restore-version').first().click();
    await page.getByText(/已恢复 v\d+/u).waitFor();
    const restored = await page.evaluate(async () => { const entry = (await window.writer.readStyleHistory((await window.writer.listProjects())[0].id)).entries[0]; return { version: entry.current.version, rules: entry.current.rules, history: entry.history.length }; });
    assert.equal(restored.version, before[0].version + 1, '恢复应记为新版本');
    assert.ok(restored.history >= 1);
    console.log('Style history desktop passed: version bumped, effect recorded, old version restored as a new version.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
