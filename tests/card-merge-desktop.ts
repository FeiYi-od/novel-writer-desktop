import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { emptyCharacter } from '../src/core/characters';

// R19-3: merging two cards keeps one, fills gaps and backs up both originals.
async function main() {
  const fixture = path.resolve('.artifacts', `card-merge-desktop-${Date.now()}`), folder = path.join(fixture, '合并小说');
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
      const cards = [
        { name: '林夏', description: '雨夜的旅人', personality: '' },
        { name: '旧稿林夏', description: '', personality: '寡言', alternateGreetings: ['雨很大。'] }
      ];
      for (const card of cards) hash = (await window.writer.saveCharacter(id, { fields: { ...base, ...card }, enabled: true }, hash)).hash;
    }, emptyCharacter());
    await page.getByRole('button', { name: '角色库', exact: true }).click();
    const oldCard = page.locator('article.character-card', { hasText: '旧稿林夏' });
    await oldCard.getByTestId('card-merge').waitFor({ timeout: 20000 });
    await oldCard.getByTestId('card-merge').click();
    const dialog = page.getByRole('dialog', { name: '合并角色卡' });
    await dialog.waitFor();
    await dialog.getByTestId('merge-into').first().click();
    await page.getByText(/已合并「旧稿林夏」→「林夏」/u).waitFor();
    const state = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const snapshot = await window.writer.readCharacters(id);
      return snapshot.value.cards.map(card => ({ name: card.name, description: card.description, personality: card.personality, greetings: card.alternateGreetings }));
    });
    assert.equal(state.length, 1, '合并后应只剩一张卡');
    assert.equal(state[0].name, '林夏');
    assert.equal(state[0].description, '雨夜的旅人', '已有字段不被覆盖');
    assert.equal(state[0].personality, '寡言', '空字段从被合并卡补齐');
    assert.deepEqual(state[0].greetings, ['雨很大。']);
    const files = await fs.readdir(path.join(fixture, 'app-data'), { recursive: true, withFileTypes: true });
    const backup = files.find(entry => entry.isFile() && entry.name.endsWith('.json') && (entry as unknown as { parentPath: string }).parentPath.includes('角色卡备份')) as unknown as { parentPath: string; name: string };
    assert.ok(backup, '合并前应留下备份文件');
    const payload = JSON.parse(await fs.readFile(path.join(backup.parentPath, backup.name), 'utf8')) as { cards: unknown[] };
    assert.equal(payload.cards.length, 2, '备份里应保留合并前的两张卡');
    console.log('Card merge desktop passed: fields filled, greetings unioned, both originals backed up.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
