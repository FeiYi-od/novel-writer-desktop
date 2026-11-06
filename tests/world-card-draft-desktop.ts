import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/world-card-draft-'));
  const folder = path.join(fixture, '虚构甲'); await fs.mkdir(folder);
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--exe' && path.isAbsolute(args[1]!)));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null; let page!: Page;
  async function launch() {
    app = await electron.launch({ executablePath: args.length ? args[1]! : createRequire(import.meta.url)('electron'), args: args.length ? [] : [path.resolve('out/main/index.js')], env });
    if (args.length) { const info = await app.evaluate(({app}) => ({ packaged: app.isPackaged, version: app.getVersion() })); assert.equal(info.packaged, true); assert.equal(info.version, JSON.parse(await fs.readFile('package.json', 'utf8')).version); }
    page = await app.firstWindow(); page.setDefaultTimeout(30000); await page.setViewportSize({ width: 1000, height: 720 }); page.on('dialog', dialog => void dialog.accept());
    await app.evaluate(({dialog}, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByText('已打开「虚构甲」', { exact: false }).waitFor();
  }
  async function stop() { await app?.evaluate(({app}) => app.exit(0)); app = null; }
  async function worldPanel() { await page.getByRole('button', { name: '世界观', exact: true }).click(); const panel = page.getByRole('region', { name: '本书世界设定卡' }); await panel.getByRole('button', { name: '刷新', exact: true }).waitFor({ state: 'visible' }); return panel; }
  try {
    await launch();
    const id = (await page.evaluate(() => window.writer.listProjects()))[0]!.id;
    const result = await page.evaluate(async projectId => {
      const plan = await window.writer.previewSettingCandidates(projectId, '地点：虚构港\n正文：旧港口资料。\n关键词：虚构港\n\n地点：虚构高原\n正文：高处风很大。\n关键词：高原');
      return window.writer.confirmSettingCandidates(projectId, plan.token, plan.candidates.map(candidate => ({ id: candidate.id })));
    }, id);
    assert.ok(result.world); const file = path.join(folder, '小说资料', '世界书', `${result.world.name}.json`);
    const original = await fs.readFile(file);
    const other = await page.evaluate(async parent => window.writer.createProject(parent, '虚构乙', true), fixture);
    let panel = await worldPanel();
    await panel.getByText('虚构港', { exact: true }).click();
    await panel.getByRole('button', { name: '编辑设定卡', exact: true }).click();
    let edit = page.getByRole('dialog', { name: '编辑世界设定卡' });
    await edit.getByLabel('设定卡内容').fill('本机尚未保存的港口草稿。');
    await edit.getByText('草稿已暂存到本机', { exact: true }).waitFor();
    assert.deepEqual(await fs.readFile(file), original);
    assert.equal(await page.evaluate(projectId => window.writer.readUiDraft(projectId, 'world-card'), other.project.id), null);
    await stop();

    await launch(); panel = await worldPanel();
    await panel.getByText('有未保存的设定卡草稿').waitFor();
    await panel.getByText('虚构高原', { exact: true }).click();
    assert.equal(await panel.getByRole('button', { name: '编辑设定卡', exact: true }).isDisabled(), true, '未处理旧草稿前不能覆盖为另一张卡的草稿');
    await panel.getByRole('button', { name: '查看并恢复草稿' }).click();
    edit = page.getByRole('dialog', { name: '编辑世界设定卡' });
    await edit.getByText(/发现上次未保存的设定卡草稿/u).waitFor();
    await edit.screenshot({ path: path.join(fixture, 'draft-recovery.png') });
    assert.equal(await edit.getByLabel('设定卡内容').isDisabled(), true, '必须由作者选择恢复');
    assert.deepEqual(await fs.readFile(file), original, '查看草稿不能改变世界书');
    await edit.getByRole('button', { name: '恢复上次草稿', exact: true }).click();
    assert.equal(await edit.getByLabel('设定卡内容').inputValue(), '本机尚未保存的港口草稿。');
    await edit.getByRole('button', { name: '保存设定卡', exact: true }).click();
    await edit.waitFor({ state: 'detached' });
    assert.match(await fs.readFile(file, 'utf8'), /本机尚未保存的港口草稿/u);
    assert.equal(await page.evaluate(projectId => window.writer.readUiDraft(projectId, 'world-card'), id), null);
    panel = page.getByRole('region', { name: '本书世界设定卡' });
    await panel.getByText('虚构港', { exact: true }).click();
    await panel.getByRole('button', { name: '编辑设定卡', exact: true }).click();
    edit = page.getByRole('dialog', { name: '编辑世界设定卡' });
    await edit.getByLabel('设定卡内容').fill('另一次尚未保存的草稿。');
    await edit.getByText('草稿已暂存到本机', { exact: true }).waitFor();
    await stop();

    const external = (await fs.readFile(file, 'utf8')) + '\n'; await fs.writeFile(file, external);
    await launch(); panel = await worldPanel();
    await panel.getByRole('button', { name: '查看并恢复草稿' }).click();
    edit = page.getByRole('dialog', { name: '编辑世界设定卡' });
    await edit.getByRole('button', { name: '恢复上次草稿', exact: true }).click();
    assert.equal(await edit.getByLabel('设定卡内容').inputValue(), '另一次尚未保存的草稿。');
    await edit.getByRole('button', { name: '保存设定卡', exact: true }).click();
    await edit.getByRole('alert').getByText(/外部变化/u).waitFor();
    assert.equal(await edit.getByLabel('设定卡内容').inputValue(), '另一次尚未保存的草稿。');
    assert.equal(await fs.readFile(file, 'utf8'), external);
    assert.ok(await page.evaluate(projectId => window.writer.readUiDraft(projectId, 'world-card'), id));
    await edit.getByRole('button', { name: '取消', exact: true }).click(); await edit.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(projectId => window.writer.readUiDraft(projectId, 'world-card'), id), null);

    const unsupported = JSON.stringify({ schemaVersion: 99, draft: '保留未知版本' });
    await page.evaluate(({ projectId, payload }) => window.writer.saveUiDraft(projectId, 'world-card', { payload }), { projectId: id, payload: unsupported });
    panel = await worldPanel(); await panel.getByRole('button', { name: '刷新', exact: true }).click();
    await panel.getByRole('alert').getByText(/草稿无法读取/u).waitFor();
    assert.equal((await page.evaluate(projectId => window.writer.readUiDraft(projectId, 'world-card'), id))?.values.payload, unsupported);
    assert.equal(await fs.readFile(file, 'utf8'), external);
    console.log('World card draft desktop passed: crash recovery, explicit adoption, cross-book isolation, conflict preservation, cancel and unsupported draft retention.');
  } finally { const activeApp = app as ElectronApplication | null; if (activeApp) await activeApp.evaluate(({app}) => app.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
