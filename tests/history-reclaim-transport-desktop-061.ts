import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Workspace } from '../src/main/workspace';
import { MaterialSyncService } from '../src/main/material-sync';

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

// 桌面只验证界面链路：选中传输版本 → 确认 → 目录真的被删、当前资料不变。
// 父版本拒绝、指纹不符、错入口等边界由 tests/history-reclaim-transport-061.test.ts 覆盖。
async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/transport-reclaim-desktop-061-'));
  const book = path.join(fixture, '虚构书'); await fs.mkdir(book, { recursive: true });
  const userData = path.join(fixture, 'profile'), materials = path.join(userData, '创作资料');
  const workspace = new Workspace(userData, materials); await workspace.initialize();
  const project = await workspace.attach(book); await workspace.readNotes(project.id);
  const service = new MaterialSyncService(workspace, materials, userData);
  // 关闭同步，避免应用打开书时自动创建新传输版本（会让本用例的版本变成父版本）
  await service.configure(project.id, false);
  const id = randomUUID(), folder = path.join(book, '小说资料', '创作资料同步', '版本', id);
  await fs.mkdir(path.join(folder, 'files'), { recursive: true });
  const payload = Buffer.from('虚构传输内容', 'utf8');
  await fs.writeFile(path.join(folder, 'files', '资料.txt'), payload);
  await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify({ schemaVersion: 1, projectId: project.id, revisionId: id,
    createdAt: new Date().toISOString(), parents: [], entries: [{ path: '资料.txt', bytes: payload.length, sha256: sha(payload) }] }, null, 2), 'utf8');
  const canonical = path.join(materials, project.id), canonicalFile = path.join(canonical, '当前.txt');
  await fs.mkdir(canonical, { recursive: true }); await fs.writeFile(canonicalFile, '虚构当前资料');

  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = userData; delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  const history = () => page.getByTestId('history-panel'), outer = () => page.getByTestId('material-sync-panel');
  const settled = () => page.waitForFunction(() => document.querySelector('[data-testid="history-panel"]')?.getAttribute('aria-busy') === 'false');
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(25000);
    page.on('dialog', dialog => { void dialog.accept(); });
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, book);
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByText(`已打开「${path.basename(book)}」`, { exact: false }).first().waitFor();
    await page.getByTestId('material-sync-open').click();
    await outer().locator('.material-sync-history summary').click();
    await outer().getByTestId('history-open').click(); await history().waitFor(); await settled();

    await history().locator(`[data-testid="history-version"][data-source="transport"][data-id="${id}"]`).click();
    await history().locator('[data-testid="history-file"]').first().waitFor();
    assert.equal(await history().getByTestId('history-reclaim').isDisabled(), false, '传输版本应允许发起回收');
    await history().getByTestId('history-reclaim').click();
    try { await history().getByText(/已回收书内传输版本/u).waitFor({ timeout: 20000 }); }
    catch (failure) { console.error('ERRTEXT', await history().getByTestId('history-error').innerText().catch(() => '(none)')); console.error('NOTICE', await history().locator('[role="status"]').allInnerTexts().catch(() => [])); throw failure; }
    assert.equal(await fs.stat(folder).then(() => true).catch(() => false), false, '传输版本目录应被删除');
    assert.equal(await fs.readFile(canonicalFile, 'utf8'), '虚构当前资料');
    assert.equal((await service.history(project.id)).versions.length, 0);
    console.log('Transport reclaim desktop passed: 选中传输版本确认后目录删除，界面提示释放字节，当前资料不变。');
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
