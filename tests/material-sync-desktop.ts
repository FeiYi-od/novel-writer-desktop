import { _electron as electron, type ElectronApplication, type Page, type Locator } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Workspace } from '../src/main/workspace';
import { MaterialSyncService } from '../src/main/material-sync';
import { emptyCharacter } from '../src/core/characters';
import { notesMarkdown, parseNotesMarkdown } from '../src/main/markdown-materials';

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/material-sync-desktop-034-'));
  const folder = path.join(fixture, '虚构同步书'); await fs.mkdir(folder);
  const aData = path.join(fixture, 'A'), bData = path.join(fixture, 'B');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | undefined; let page!: Page; let panel!: Locator; const errors: string[] = [];
  const launch = async (userData: string) => {
    app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [path.resolve('out/main/index.js')], env: { ...env, NOVEL_WRITER_TEST_DATA: userData } });
    page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => void d.accept());
    panel = page.getByTestId('material-sync-panel');
  };
  const open = async (book = folder) => {
    await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, book);
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByText(`已打开「${path.basename(book)}」`, { exact: false }).first().waitFor();
  };
  const exit = async () => { const closed = app!.waitForEvent('close', { timeout: 25000 }); await page.getByRole('button', { name: '保存并退出', exact: true }).click(); await closed; app = undefined; };
  const saveWorld = async (text: string) => {
    await page.getByRole('button', { name: '世界观', exact: true }).click(); await page.locator('#project-note').fill(text);
    await page.getByRole('button', { name: '保存本书资料', exact: true }).click();
    await page.getByText('本书资料已保存', { exact: true }).waitFor();
  };
  try {
    await launch(aData); await open();
    const id = JSON.parse(await fs.readFile(path.join(folder, '小说资料/project.json'), 'utf8')).id as string;
    const aCanonical = path.join(aData, '创作资料', id), bCanonical = path.join(bData, '创作资料', id);
    await saveWorld('A端确认：月光驱动星港。');
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节', exact: true }).click();
    await page.locator('.tiptap').fill('虚构星港开始营业。'); await page.getByRole('button', { name: '保存 DOCX', exact: true }).click();
    await page.getByText('DOCX 已保存到所选文件夹', { exact: true }).waitFor();
    const chapter = (await fs.readdir(folder)).find(file => file.endsWith('.docx'))!;
    const body = await fs.readFile(path.join(folder, chapter));
    await page.evaluate(async payload => {
      const cards = await window.writer.readCharacters(payload.id);
      await window.writer.saveCharacter(payload.id, { fields: payload.fields, enabled: true }, cards.hash);
    }, { id, fields: { ...emptyCharacter(), name: '虚构领航员', description: '仅用于测试' } });
    await page.getByTestId('material-sync-open').click();
    await panel.getByTestId('material-sync-toggle').click();
    await panel.getByTestId('material-sync-run').click(); await panel.getByTestId('material-sync-result').waitFor();
    await panel.getByTestId('material-sync-close').click();
    // Unsaved notes must survive a blocked manual sync.
    await page.locator('#project-note').fill('尚未保存的草稿'); await page.getByTestId('material-sync-open').click();
    await panel.getByTestId('material-sync-run').click();
    await panel.getByTestId('material-sync-error').filter({ hasText: '请先保存' }).waitFor();
    await panel.getByTestId('material-sync-close').click(); assert.equal(await page.locator('#project-note').inputValue(), '尚未保存的草稿');
    await saveWorld('A端更新：星港只在满月开放。'); await exit();
    // A second isolated profile models another Windows installation, with no NAS credentials.
    await launch(bData); await open(); await page.getByRole('button', { name: '世界观', exact: true }).click();
    assert.equal(await page.locator('#project-note').inputValue(), 'A端更新：星港只在满月开放。');
    const bCards = await page.evaluate(async projectId => (await window.writer.readCharacters(projectId)).value.cards.map(card => card.name), id);
    assert.deepEqual(bCards, ['虚构领航员']);
    assert.equal(await fs.readFile(path.join(aCanonical, '人物卡.md'), 'utf8'), await fs.readFile(path.join(bCanonical, '人物卡.md'), 'utf8'));
    await saveWorld('B端更新：虚构领航员管理星港。'); await exit();
    await launch(aData); await open(); await page.getByRole('button', { name: '世界观', exact: true }).click();
    assert.equal(await page.locator('#project-note').inputValue(), 'B端更新：虚构领航员管理星港。');
    await saveWorld('A本机未同步版本');
    const b = new Workspace(bData, path.join(bData, '创作资料')); await b.initialize(); await b.attach(folder);
    const bNotes = await b.readNotes(id); await b.saveNotes(id, { ...bNotes.value, world: 'B并行传输版本' }, bNotes.hash);
    await new MaterialSyncService(b, path.join(bData, '创作资料'), bData).synchronize({ projectId: id });
    await page.getByRole('button', { name: '保存并退出', exact: true }).click();
    await panel.waitFor(); await page.getByRole('alert').filter({ hasText: '保存并退出未完成' }).waitFor();
    await panel.locator('[data-testid="material-sync-remote"][data-path="创作笔记.md"]').click();
    // A changed source after preview must invalidate the choice and preserve the new source.
    const notesFile = path.join(aCanonical, '创作笔记.md');
    const current = parseNotesMarkdown(await fs.readFile(notesFile, 'utf8'), id);
    await fs.writeFile(notesFile, notesMarkdown({ ...current, world: '外部追加新版本' }));
    await panel.getByTestId('material-sync-run').click(); await panel.getByTestId('material-sync-error').filter({ hasText: '变化' }).waitFor();
    assert.equal(parseNotesMarkdown(await fs.readFile(notesFile, 'utf8'), id).world, '外部追加新版本');
    await panel.getByTestId('material-sync-refresh').click();
    await panel.locator('[data-testid="material-sync-remote"][data-path="创作笔记.md"]').click();
    await panel.getByTestId('material-sync-run').click(); await panel.getByTestId('material-sync-result').waitFor();
    await page.screenshot({ path: path.join(fixture, 'material-sync.png') });
    await panel.getByTestId('material-sync-close').click();
    assert.equal(await page.locator('#project-note').inputValue(), 'B并行传输版本');
    assert.deepEqual(await fs.readFile(path.join(folder, chapter)), body);
    const another = path.join(fixture, '独立第二本'); await fs.mkdir(another); await open(another);
    const otherId = JSON.parse(await fs.readFile(path.join(another, '小说资料/project.json'), 'utf8')).id as string;
    assert.notEqual(otherId, id); const status = await page.evaluate(projectId => window.writer.materialSyncStatus(projectId), otherId); assert.equal(status.status, 'disabled');
    await exit(); assert.deepEqual(errors, []);
    console.log(`Material sync desktop passed: A/B isolated profiles, real DOCX unchanged, fixed card/world pull, save-exit publish, dirty guard, conflict retains window, stale-choice rejection, explicit remote adoption and book isolation. Artifacts: ${fixture}`);
  } finally { if (app) await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
