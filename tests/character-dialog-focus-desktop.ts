import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/character-modal-focus-'));
  const folder = path.join(fixture, '虚构角色小说'); await fs.mkdir(folder);
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'userdata') } });
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(20000);
    await app.evaluate(({ dialog }, chosen) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByRole('button', { name: '角色库', exact: true }).first().click();
    const open = page.getByRole('button', { name: '＋ 新建文字角色卡', exact: true }); await open.waitFor();
    const verifyModal = async (name: string) => {
      const dialog = page.getByRole('dialog', { name }); await dialog.waitFor();
      assert.equal(await dialog.evaluate(node => node.matches(':modal')), true, 'native top-layer modal isolates its background');
      for (const key of [...Array(30).fill('Tab'), ...Array(30).fill('Shift+Tab')]) {
        await page.keyboard.press(key);
        assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, `${key} escaped ${name}`);
      }
      const backgroundBlocked = await page.evaluate(() => { const background = document.querySelector<HTMLElement>('.main-nav button'); background?.focus(); return !background || document.querySelector(':modal')?.contains(document.activeElement); });
      assert.equal(backgroundBlocked, true, 'programmatic focus cannot enter the inert background');
    };
    await open.click(); await verifyModal('角色卡编辑');
    await page.getByLabel('角色名称').fill('虚构草稿');
    page.once('dialog', dialog => void dialog.dismiss()); await page.keyboard.press('Escape');
    assert.equal(await page.getByLabel('角色名称').inputValue(), '虚构草稿', 'declining close retains edits');
    page.once('dialog', dialog => void dialog.accept()); await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: '角色卡编辑' }).waitFor({ state: 'detached' });
    assert.equal(await open.evaluate(node => node === document.activeElement), true, 'closing restores the triggering control');
    for (const name of ['虚构甲', '虚构乙']) {
      await open.click(); await page.getByLabel('角色名称').fill(name);
      await page.getByRole('button', { name: '保存角色卡', exact: true }).click();
      await page.getByRole('dialog', { name: '角色卡编辑' }).waitFor({ state: 'detached' });
    }
    const merge = page.getByTestId('card-merge').first(); await merge.click(); await verifyModal('合并角色卡');
    await page.keyboard.press('Escape'); await page.getByRole('dialog', { name: '合并角色卡' }).waitFor({ state: 'detached' });
    assert.equal(await merge.evaluate(node => node === document.activeElement), true, 'merge close restores its trigger');
    await page.getByRole('button', { name: '查看与编辑', exact: true }).first().click();
    const editing = page.getByRole('dialog', { name: '角色卡编辑' });
    await page.getByLabel('角色名称').fill('待保存虚构稿');
    await page.evaluate(async () => {
      const project = (await window.writer.listProjects())[0];
      const snapshot = await window.writer.readCharacters(project.id);
      const card = snapshot.value.cards[0];
      await window.writer.saveCharacter(project.id, { id: card.id, fields: { ...card, description: '虚构外部变更' }, enabled: card.enabled }, snapshot.hash);
    });
    await editing.getByRole('button', { name: '保存角色卡', exact: true }).click();
    await editing.getByRole('alert').filter({ hasText: '角色库已在外部' }).waitFor();
    assert.equal(await page.getByLabel('角色名称').inputValue(), '待保存虚构稿', 'conflict stays visible inside modal and preserves edits');
    await app.evaluate(() => {
      const native = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises');
      const original = native.writeFile;
      (native as any).writeFile = async (...args: any[]) => { if (String(args[0]).includes('ui-drafts')) throw new Error('虚构备份故障'); return (original as any)(...args); };
    });
    await page.getByLabel('角色名称').fill('待备份虚构稿');
    await editing.getByRole('alert').filter({ hasText: '未保存草稿自动备份失败' }).waitFor();
    assert.equal(await page.getByLabel('角色名称').inputValue(), '待备份虚构稿', 'backup failure stays visible inside modal and preserves edits');
    console.log(`Character modal focus desktop passed: ${fixture}`);
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
