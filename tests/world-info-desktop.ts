import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { emptyCharacter } from '../src/core/characters';

// R19-1: importing a SillyTavern world book and previewing triggered entries for the chapter.
async function main() {
  const fixture = path.resolve('.artifacts', `world-desktop-${Date.now()}`), folder = path.join(fixture, '世界书小说');
  await fs.mkdir(folder, { recursive: true });
  const worldFile = path.join(fixture, '北方世界.json');
  await fs.writeFile(worldFile, JSON.stringify({ name: '北方世界', entries: {
    '0': { key: ['北门'], content: '北门在雨夜关闭，守门人不收铜钱。', order: 5 },
    '1': { key: ['月钥'], content: '月钥只认林夏的血。', order: 9 },
    '2': { key: ['不会出现'], content: '这条不该被触发。', order: 1 },
    '3': { key: ['北门'], content: '启用角色专属虚构条目。', characterFilter: { isExclude: false, names: ['林夏'], tags: [] } },
    '4': { key: ['北门'], content: '未启用角色专属虚构条目。', characterFilter: { isExclude: false, names: ['未启用角色'], tags: [] } },
    '5': { key: ['星港'], content: '标签包含设定。', characterFilter: { isExclude: false, names: [], tags: ['tag-alpha'] } },
    '6': { key: ['星港'], content: '标签排除设定。', characterFilter: { isExclude: true, names: [], tags: ['tag-beta'] } },
    '7': { key: ['星港'], content: '头像和标签同时限定的设定。', characterFilter: { isExclude: false, names: ['avatar-lin'], tags: ['tag-alpha'] } }
  } }, null, 2), 'utf8');
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  const queue = [folder, worldFile];
  try {
    await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.shift() ?? ''] }); }, queue);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    await page.evaluate(async fields => {
      const id = (await window.writer.listProjects())[0].id;
      let cards = await window.writer.readCharacters(id);
      cards = await window.writer.saveCharacter(id, { fields: { ...fields, name: '林夏' }, enabled: true }, cards.hash);
      await window.writer.saveCharacter(id, { fields: { ...fields, name: '未启用角色' }, enabled: false }, cards.hash);
    }, emptyCharacter());
    const chapterPath = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const chapter = await window.writer.createChapter(id, 'docx');
      await window.writer.saveChapter({ projectId: id, path: chapter.path, expectedHash: chapter.hash,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '林夏走到北门，握紧月钥。' }] }] } });
      return chapter.path;
    });
    await page.getByRole('button', { name: '↻' }).click();
    await page.getByTestId('world-open').click();
    const dialog = page.getByRole('dialog', { name: '世界书' });
    await dialog.waitFor();
    await dialog.getByLabel('检查用文本').fill('林夏走到北门，握紧月钥。');
    await dialog.getByTestId('world-import').click();
    await dialog.getByText(/已导入「北方世界」/u).waitFor();
    await page.waitForFunction(() => { const el = document.querySelector('[data-testid="world-preview"]') as HTMLButtonElement | null; return !!el && !el.disabled; }, undefined, { timeout: 15000 });
    await page.click('[data-testid="world-preview"]');
    await dialog.getByText(/当前章节会触发 3 条/u).waitFor();
    const text = await dialog.innerText();
    assert.match(text, /北门在雨夜关闭/u);
    assert.match(text, /月钥只认林夏的血/u);
    assert.match(text, /启用角色专属虚构条目/u);
    assert.doesNotMatch(text, /未启用角色专属虚构条目/u);
    assert.doesNotMatch(text, /这条不该被触发/u, '未命中的条目不应出现在预览里');
    await dialog.getByTestId('tag-mapping-open').click();
    const mapping = page.getByRole('dialog', { name: '酒馆角色关联' });
    await mapping.getByRole('checkbox', { name: '林夏', exact: true }).waitFor();
    await mapping.getByRole('button', { name: '关闭', exact: true }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await mapping.getByRole('checkbox', { name: '林夏', exact: true }).evaluate(el => el === document.activeElement), true, 'Tab 必须保持在关联弹窗内');
    await mapping.getByRole('checkbox', { name: '林夏', exact: true }).check();
    await mapping.getByLabel('林夏 酒馆头像标识').fill('avatar-lin');
    await mapping.getByRole('checkbox', { name: '已确认该角色的酒馆标签 ID' }).check();
    await mapping.getByLabel('林夏 标签 ID').fill('tag-alpha');
    await page.screenshot({ path: path.join(fixture, 'mapping-preview.png') });
    await page.locator('button.save-exit').evaluate((button: HTMLElement) => button.click());
    await mapping.waitFor();
    assert.equal(await mapping.getByLabel('林夏 标签 ID').inputValue(), 'tag-alpha', '未保存关联必须阻止保存退出并保留输入');
    await mapping.getByRole('button', { name: '关闭', exact: true }).click();
    await mapping.getByRole('alert').getByText(/未保存修改/u).waitFor();
    await mapping.getByRole('button', { name: '确认并保存' }).click();
    await mapping.getByText(/关联已确认并保存/u).waitFor();
    const binding = await page.evaluate(async () => { const id = (await window.writer.listProjects())[0].id; return window.writer.readCharacterTagMappings(id); });
    assert.equal(binding.mappings.length, 1); assert.equal(binding.mappings[0].avatarKey, 'avatar-lin'); assert.deepEqual(binding.mappings[0].tagIds, ['tag-alpha']);
    await mapping.getByRole('button', { name: '关闭', exact: true }).click();
    await mapping.waitFor({ state: 'detached' });
    await page.evaluate(async fields => {
      const id = (await window.writer.listProjects())[0].id;
      const cards = await window.writer.readCharacters(id);
      const target = cards.value.cards.find(card => card.name === '林夏')!;
      await window.writer.saveCharacter(id, { id: target.id, fields: { ...fields, name: '林夏', description: '虚构角色设定变更' }, enabled: true }, cards.hash);
    }, emptyCharacter());
    assert.equal(await page.evaluate(async () => { const id = (await window.writer.listProjects())[0].id; return (await window.writer.readCharacterTagMappings(id)).stale; }), true);
    await dialog.getByTestId('tag-mapping-open').click();
    await mapping.getByText(/旧关联暂不用于写作/u).waitFor();
    await app.evaluate(({ dialog: nativeDialog }) => {
      const fs = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises');
      const original = fs.rename;
      (globalThis as any).__mappingWriteStarted = false;
      (nativeDialog as any).showMessageBoxSync = () => { (globalThis as any).__mappingClosePrompted = true; return 0; };
      (fs as any).rename = async (from: string, to: string) => {
        if (to.endsWith('酒馆角色关联.json')) {
          (fs as any).rename = original;
          (globalThis as any).__mappingWriteStarted = true;
          await new Promise<void>(resolve => { (globalThis as any).__resumeMappingWrite = resolve; });
        }
        return original(from, to);
      };
    });
    await mapping.getByRole('button', { name: '确认并保存' }).click();
    for (let attempt = 0; attempt < 100 && !await app.evaluate(() => Boolean((globalThis as any).__mappingWriteStarted)); attempt++) await page.waitForTimeout(30);
    assert.equal(await app.evaluate(() => Boolean((globalThis as any).__mappingWriteStarted)), true);
    assert.equal(await mapping.getByRole('button', { name: '关闭', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('button.save-exit').isDisabled(), true);
    assert.equal(await page.locator('[aria-label="世界书"]').evaluate(el => el.closest('.modal-overlay')?.hasAttribute('inert')), true);
    await mapping.focus(); await page.keyboard.press('Escape');
    assert.equal(await mapping.count(), 1, '处理期间 Escape 不得关闭关联面板');
    await page.locator('[aria-label="世界书"] > footer button').evaluate((button: HTMLElement) => button.click());
    assert.equal(await mapping.count(), 1, '处理期间父弹窗关闭请求不得卸载关联面板');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await page.waitForTimeout(100);
    assert.equal(page.isClosed(), false, '保存过程中原生关闭窗口必须保留窗口');
    assert.equal(await app.evaluate(() => Boolean((globalThis as any).__mappingClosePrompted)), true);
    await app.evaluate(() => (globalThis as any).__resumeMappingWrite());
    await mapping.getByText(/关联已确认并保存/u).waitFor();
    await mapping.getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal(await page.evaluate(async () => { const id = (await window.writer.listProjects())[0].id; return (await window.writer.readCharacterTagMappings(id)).stale; }), false);
    await dialog.getByLabel('检查用文本').fill('星港');
    await dialog.getByLabel('手动指定本次预览的酒馆标签 ID').check();
    await dialog.getByTestId('world-preview').click();
    await dialog.getByText(/当前章节会触发 1 条/u).waitFor();
    assert.match(await dialog.innerText(), /标签排除设定/u);
    await dialog.getByLabel('酒馆标签 ID', { exact: true }).fill('tag-alpha');
    await dialog.getByTestId('world-preview').click();
    await dialog.getByText(/当前章节会触发 2 条/u).waitFor();
    assert.match(await dialog.innerText(), /标签包含设定/u);
    await page.screenshot({ path: path.join(fixture, 'tag-preview.png') });
    await dialog.getByLabel('酒馆标签 ID', { exact: true }).fill('tag-beta');
    await dialog.getByTestId('world-preview').click();
    await dialog.getByText(/当前章节会触发 0 条/u).waitFor();
    await dialog.getByLabel('手动指定本次预览的酒馆标签 ID').uncheck();
    await dialog.getByTestId('world-preview').click();
    await dialog.getByText(/当前章节会触发 3 条/u).waitFor();
    assert.match(await dialog.innerText(), /头像和标签同时限定的设定/u);
    const storedFile = path.join(folder, '小说资料', '世界书', '北方世界.json');
    const changed = JSON.stringify({ name: '北方世界', entries: { '0': { key: ['星港'], content: '外部更新的虚构设定' } } });
    await fs.writeFile(storedFile, changed);
    await dialog.getByRole('button', { name: '删除', exact: true }).click();
    await dialog.getByRole('alert').getByText(/世界书版本已变化/u).waitFor();
    assert.equal(await fs.readFile(storedFile, 'utf8'), changed);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByTestId('world-open').click();
    await dialog.getByText(/北方世界/u).first().waitFor();
    await dialog.getByRole('button', { name: '删除', exact: true }).click();
    await dialog.getByText(/原文件已备份/u).waitFor();
    const backup = path.join(folder, '小说资料', '世界书删除备份');
    const copies = await fs.readdir(backup); assert.equal(copies.length, 1);
    assert.equal(await fs.readFile(path.join(backup, copies[0]), 'utf8'), changed);
    await assert.rejects(fs.stat(storedFile), { code: 'ENOENT' });
    console.log('World info desktop passed: character and tag preview, stale delete refusal, original-byte backup.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
