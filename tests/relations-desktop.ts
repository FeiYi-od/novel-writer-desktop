import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { emptyCharacter } from '../src/core/characters';

// R23-3: relations are created from two characters and shown from both sides.
async function main() {
  const fixture = path.resolve('.artifacts', `relations-desktop-${Date.now()}`), folder = path.join(fixture, '关系小说');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    await page.evaluate(async payload => {
      const id = (await window.writer.listProjects())[0].id;
      let hash = (await window.writer.readCharacters(id)).hash;
      for (const name of payload.names) {
        hash = (await window.writer.saveCharacter(id, { fields: { ...payload.base, name }, enabled: true }, hash)).hash;
      }
    }, { names: ['林夏', '阿岚'], base: emptyCharacter() });
    await page.getByRole('button', { name: '人物关系…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '人物关系' });
    await dialog.waitFor();
    await dialog.getByLabel('关系角色A').selectOption('林夏');
    await dialog.getByLabel('关系角色B').selectOption('阿岚');
    await dialog.getByLabel('关系名称').fill('师徒');
    await dialog.getByLabel('关系强度').selectOption('5');
    await dialog.getByRole('button', { name: '添加关系', exact: true }).click();
    await dialog.getByRole('button', { name: '保存人物关系', exact: true }).click();
    await page.getByText('人物关系已保存', { exact: true }).waitFor();
    const state = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      return window.writer.readRelations(id);
    });
    assert.equal(state.relations.length, 1);
    assert.deepEqual(state.groups.map(group => group.name), ['阿岚', '林夏'], '关系两端都应出现');
    assert.ok(state.groups.every(group => group.items[0].relation.label === '师徒'));
    const files = await fs.readdir(path.join(folder, '小说资料'));
    assert.ok(files.some(name => name === '人物关系.json'), '关系应保存为本书资料');
    console.log('Relations desktop passed: relation saved and visible from both characters.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
