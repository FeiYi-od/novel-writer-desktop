import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cardPng, v2 } from './card-fixtures';

async function main() {
  const root = await fs.mkdtemp(path.resolve('.artifacts/character-reselect-'));
  const folder = path.join(root, '虚构小说'); await fs.mkdir(folder);
  const cardFile = path.join(root, '虚构卡.json');
  const imageFile = path.join(root, '虚构卡.png'); await fs.writeFile(imageFile, cardPng([{ key: 'chara', value: v2 }]));
  const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: '虚构角色', description: '原设定', personality: '', scenario: '', first_mes: '', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: { fictional_test: '原扩展' } } };
  await fs.writeFile(cardFile, JSON.stringify(card));
  let app!: ElectronApplication; let page!: Page;
  async function launch() {
    app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(root, 'local') } });
    page = await app.firstWindow(); page.setDefaultTimeout(20000);
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '角色库', exact: true }).first().click();
    await page.getByRole('button', { name: '导入文字角色卡', exact: true }).waitFor();
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, cardFile);
  }
  await launch();
  try {
    await page.getByRole('button', { name: '导入文字角色卡', exact: true }).click();
    await page.getByLabel('角色描述').fill('作者修改的设定');
    let ready = false;
    for (let i = 0; i < 80 && !ready; i++) {
      await page.waitForTimeout(100);
      ready = await page.evaluate(async () => { const project = (await window.writer.listProjects())[0]; const draft = project && await window.writer.readUiDraft(project.id, 'characters'); return Boolean(draft && JSON.parse(draft.values.draft).edit.fields.description === '作者修改的设定'); });
    }
    assert.ok(ready, '必须等待草稿写入');
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
  await launch();
  try {
    await page.getByRole('alert').filter({ hasText: '导入原卡的临时数据已失效' }).waitFor();
    assert.equal(await page.getByLabel('角色描述').inputValue(), '作者修改的设定');
    assert.equal(await page.getByRole('button', { name: '确认导入', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '重新选择文字角色卡' }).click();
    assert.equal(await page.getByLabel('角色描述').inputValue(), '作者修改的设定');
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await page.getByRole('dialog', { name: '角色卡编辑' }).waitFor({ state: 'detached' });
    const cards = await page.evaluate(async () => { const project = (await window.writer.listProjects())[0]; return (await window.writer.readCharacters(project.id)).value.cards; });
    assert.equal(cards.length, 1); assert.equal(cards[0].description, '作者修改的设定');
    assert.ok(cards[0].source.original.endsWith('.json')); assert.ok(JSON.stringify(cards[0].raw).includes('原扩展'));
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, imageFile);
    await page.getByRole('button', { name: '导入图片角色卡', exact: true }).click();
    await page.getByLabel('角色描述').fill('虚构图片卡修改');
    await page.getByRole('button', { name: '选择角色头像', exact: true }).click();
    let ready = false;
    for (let i = 0; i < 80 && !ready; i++) {
      await page.waitForTimeout(100);
      ready = await page.evaluate(async () => { const project = (await window.writer.listProjects())[0]; const draft = project && await window.writer.readUiDraft(project.id, 'characters'); if (!draft) return false; const value = JSON.parse(draft.values.draft); return Boolean(value.edit.importToken && value.edit.portraitToken && value.edit.fields.description === '虚构图片卡修改'); });
    }
    assert.ok(ready, '图片角色卡和头像草稿必须落盘');
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
  await launch();
  try {
    await page.getByText('导入原卡的临时数据已失效', { exact: false }).waitFor();
    await page.getByText('头像的临时数据已失效', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: '确认导入', exact: true }).isDisabled(), true);
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, imageFile);
    await page.getByRole('button', { name: '重新选择图片角色卡', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '确认导入', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '选择角色头像', exact: true }).click();
    assert.equal(await page.getByLabel('角色描述').inputValue(), '虚构图片卡修改');
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await page.getByRole('dialog', { name: '角色卡编辑' }).waitFor({ state: 'detached' });
    const cards = await page.evaluate(async () => { const project = (await window.writer.listProjects())[0]; return (await window.writer.readCharacters(project.id)).value.cards; });
    assert.equal(cards.length, 2); const saved = cards.find(item => item.description === '虚构图片卡修改');
    assert.ok(saved?.portrait); assert.ok(saved?.source.original.endsWith('.png')); assert.ok(JSON.stringify(saved?.raw).includes('原样保留'));
    console.log(`Character import and portrait reselect desktop passed: ${root}`);
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
