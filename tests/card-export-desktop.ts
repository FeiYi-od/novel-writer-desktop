import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { emptyCharacter } from '../src/core/characters';

// R19-3: cards export as SillyTavern PNGs, and deletion keeps a backup of the original library.
async function main() {
  const fixture = path.resolve('.artifacts', `card-export-desktop-${Date.now()}`), folder = path.join(fixture, '名片小说');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    await page.evaluate(async base => {
      const id = (await window.writer.listProjects())[0].id;
      let hash = (await window.writer.readCharacters(id)).hash;
      for (const [name, description] of [['林夏', '雨夜的旅人'], ['阿岚', '剑客']]) {
        hash = (await window.writer.saveCharacter(id, { fields: { ...base, name, description }, enabled: true }, hash)).hash;
      }
    }, emptyCharacter());
    await page.getByRole('button', { name: '角色库', exact: true }).click();
    const projectId = await page.evaluate(async () => (await window.writer.listProjects())[0].id);
    await page.locator('[data-testid="card-export"]').first().waitFor({ timeout: 20000 });
    // 导出：生成 ST 可直接读取的 PNG
    await page.getByTestId('card-export').first().click();
    await page.getByText(/已导出 .*\.png/u).waitFor();
    const exported = await page.evaluate(async (id: string) => {
      const snapshot = await window.writer.readCharacters(id);
      const card = snapshot.value.cards.find(item => item.name === '林夏')!;
      return window.writer.exportCharacterCard(id, card.id);
    }, projectId);
    assert.equal(exported.specVersion, 3);
    assert.equal(exported.name, '林夏');
    const all = await fs.readdir(path.join(fixture, 'app-data'), { recursive: true, withFileTypes: true });
    const png = all.find(entry => entry.isFile() && entry.name.endsWith('.png'));
    assert.ok(png, '导出目录里应有 PNG 文件');
    const bytes = await fs.readFile(path.join((png as unknown as { parentPath: string }).parentPath ?? path.dirname(png.name), png.name));
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG', '导出的应是 PNG');
    // 删除：先备份
    await page.getByTestId('card-remove').first().click();
    await page.getByText(/已删除「林夏」/u).waitFor();
    const after = await page.evaluate(async (id: string) => (await window.writer.readCharacters(id)).value.cards.map(card => card.name), projectId);
    assert.deepEqual(after, ['阿岚']);
    const backupDirs = await fs.readdir(path.join(fixture, 'app-data'), { recursive: true, withFileTypes: true });
    const backups = backupDirs.filter(entry => entry.isFile() && entry.name.endsWith('.json') && (entry as unknown as { parentPath: string }).parentPath.includes('角色卡备份')).map(entry => entry.name);
    assert.equal(backups.length, 1, '删除前应留下备份文件');
    const backupFile = backupDirs.find(entry => entry.isFile() && entry.name === backups[0]) as unknown as { parentPath: string };
    const backup = JSON.parse(await fs.readFile(path.join(backupFile.parentPath, backups[0]), 'utf8')) as { cards: { name: string }[] };
    assert.deepEqual(backup.cards.map(card => card.name).sort(), ['林夏', '阿岚'].sort(), '备份应保留被删角色的原始内容');
    console.log('Card export desktop passed: PNG export readable and deletion keeps a full backup.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
