import { _electron as electron } from 'playwright';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R32-1/R32-2: the NAS panel probes reachability and classifies a folder without any credentials.
async function main() {
  const server = createServer(socket => socket.end());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const fixture = path.resolve('.artifacts', `nas-panel-${Date.now()}`), folder = path.join(fixture, '本地小说');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    await page.getByTestId('nas-open').click();
    const dialog = page.getByRole('dialog', { name: 'NAS 连接检查' });
    await dialog.waitFor();
    await dialog.getByLabel('NAS 目标').fill(`127.0.0.1:${port}\n127.0.0.1:1`);
    await dialog.getByTestId('nas-probe').click();
    await dialog.getByText('可达', { exact: true }).waitFor();
    const rows = await dialog.locator('.nas-table tbody tr').allTextContents();
    assert.equal(rows.length, 2);
    assert.match(rows[0]!, /可达/u);
    assert.match(rows[1]!, /不可达/u, `关闭的端口应显示不可达：${rows[1]}`);
    // 文件夹位置判断：本地盘 / UNC
    await dialog.getByLabel('检查文件夹').fill(folder);
    await dialog.getByRole('button', { name: '判断位置' }).click();
    await dialog.getByText(/位置类型：/u).waitFor();
    assert.match(await dialog.innerText(), /位置类型/u);
    const kind = await page.evaluate(async (target: string) => ({ local: await window.writer.nasLocation(target), unc: await window.writer.nasLocation('\\\\192.0.2.1\\小说编辑器') }), folder);
    assert.equal(kind.local, 'local', `本地文件夹应判为本地盘，实际 ${kind.local}`);
    assert.equal(kind.unc, 'unc', 'UNC 路径应判为网络路径');
    console.log('NAS panel desktop passed: probe shows reachable/unreachable, folder classified without credentials.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); server.close(); await new Promise<void>(resolve => setTimeout(resolve, 50)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
