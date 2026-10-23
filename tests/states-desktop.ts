import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { emptyCharacter } from '../src/core/characters';

// R23-4: a character state with a chapter range is saved and shown for the current chapter.
async function main() {
  const fixture = path.resolve('.artifacts', `states-desktop-${Date.now()}`), folder = path.join(fixture, '状态小说');
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
      await window.writer.saveCharacter(id, { fields: { ...payload.base, name: payload.name }, enabled: true }, hash);
      for (const text of ['第一章正文。', '第二章正文。']) {
        const chapter = await window.writer.createChapter(id, 'docx');
        await window.writer.saveChapter({ projectId: id, path: chapter.path, expectedHash: chapter.hash,
          content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } });
      }
    }, { base: emptyCharacter(), name: '林夏' });
    await page.getByRole('button', { name: '↻' }).click();
    const firstName = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      return (await window.writer.chapters(id))[0].name;
    });
    await page.getByRole('button', { name: firstName }).first().click();
    await page.getByRole('button', { name: '人物状态…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '人物状态' });
    await dialog.waitFor();
    await dialog.getByLabel('状态角色').selectOption('林夏');
    await dialog.getByLabel('状态名称').fill('受伤');
    await dialog.getByLabel('起始章').fill('1');
    await dialog.getByLabel('结束章').fill('1');
    await dialog.getByRole('button', { name: '添加状态', exact: true }).click();
    await dialog.getByRole('button', { name: '保存人物状态', exact: true }).click();
    await page.getByText('人物状态已保存', { exact: true }).waitFor();
    const saved = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      return window.writer.readCharacterStates(id);
    });
    assert.deepEqual(saved.states.map(item => [item.character, item.label, item.fromChapter, item.toChapter]), [['林夏', '受伤', 1, 1]]);
    await dialog.getByText(/当前是第 1 章，生效状态：林夏·受伤/u).waitFor();
    const files = await fs.readdir(path.join(folder, '小说资料'));
    assert.ok(files.some(name => name === '人物状态.json'), '状态应保存为本书资料');
    console.log('Character states desktop passed: state saved with chapter range and shown for the current chapter.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
