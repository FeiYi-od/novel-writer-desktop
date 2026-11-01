import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Workspace } from '../src/main/workspace';
import { MaterialSyncService } from '../src/main/material-sync';

async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/history-reclaim-desktop-061-'));
  const book = path.join(fixture, '虚构书');
  await fs.mkdir(book, { recursive: true });
  const userData = path.join(fixture, 'profile'), materials = path.join(userData, '创作资料');
  const workspace = new Workspace(userData, materials); await workspace.initialize();
  const project = await workspace.attach(book); await workspace.readNotes(project.id);
  const service = new MaterialSyncService(workspace, materials, userData); await service.configure(project.id, false);
  const historyId = randomUUID(), localRoot = path.join(materials, '同步历史', project.id), folder = path.join(localRoot, historyId);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, '旧设定.txt'), '虚构旧设定：回收后应消失。');
  const canonical = path.join(materials, project.id), canonicalFile = path.join(canonical, '当前.txt');
  await fs.mkdir(canonical, { recursive: true }); await fs.writeFile(canonicalFile, '虚构当前资料，回收不影响。');

  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = userData; delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  const history = () => page.getByTestId('history-panel'), outer = () => page.getByTestId('material-sync-panel');
  const settled = () => page.waitForFunction(() => document.querySelector('[data-testid="history-panel"]')?.getAttribute('aria-busy') === 'false');
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(25000);
    // 本测试只验证“确认后真的回收”；取消/伪造响应等路径由核心用例与既有保留区桌面测试覆盖。
    page.on('dialog', dialog => { void dialog.accept(); });
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, book);
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByText(`已打开「${path.basename(book)}」`, { exact: false }).first().waitFor();
    await page.getByTestId('material-sync-open').click();
    await outer().locator('.material-sync-history summary').click();
    await outer().getByTestId('history-open').click(); await history().waitFor(); await settled();

    // 第一步：活动区历史先移到保留区（活动区不允许直接回收）
    await history().locator(`[data-testid="history-version"][data-id="${historyId}"]`).click();
    await history().locator('[data-testid="history-file"][data-path="旧设定.txt"]').waitFor();
    await history().getByTestId('history-retain').click();
    await settled();
    assert.equal(await history().locator(`[data-testid="history-version"][data-id="${historyId}"]`).getAttribute('data-location'), 'retained');

    // 第二步：重新选中保留区条目，回收按钮才可用（保留成功后选择会被清空）
    await history().locator(`[data-testid="history-version"][data-id="${historyId}"]`).click();
    await history().locator('[data-testid="history-file"][data-path="旧设定.txt"]').waitFor();
    assert.equal(await history().getByTestId('history-reclaim').isDisabled(), false);

    // 第三步：确认后真正删除，界面提示释放字节
    await history().getByTestId('history-reclaim').click();
    await settled();
    await history().getByText(/已回收保留区历史/u).waitFor();
    assert.equal(await fs.stat(path.join(materials, '同步历史保留', project.id, historyId)).then(() => true).catch(() => false), false, '保留区历史应被删除');
    assert.equal(await fs.readFile(canonicalFile, 'utf8'), '虚构当前资料，回收不影响。');
    assert.equal((await service.history(project.id)).versions.length, 0);
    console.log('History reclaim desktop passed: 保留区历史确认后删除，当前资料与活动区不变，界面显示释放字节。');
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
