import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { textDocument } from '../src/main/text-import';

// R32-4: back up the open book to a chosen folder, verify the manifest, and never overwrite.
async function main() {
  const fixture = path.resolve('.artifacts', `nas-backup-desktop-${Date.now()}`);
  const folder = path.join(fixture, '备份小说');
  const target = path.join(fixture, '备份目标');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  const queue = [folder, target];
  try {
    await app.evaluate(({ dialog }, paths) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.shift() ?? path.dirname(paths[0] ?? '.')] });
    }, queue);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const chapter = await window.writer.createChapter(id, 'docx');
      await window.writer.saveChapter({ projectId: id, path: chapter.path, expectedHash: chapter.hash,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '备份验证用的虚构正文。' }] }] } });
    });
    await page.getByTestId('nas-open').click();
    const dialog = page.getByRole('dialog', { name: 'NAS 连接检查' });
    await dialog.waitFor();
    await dialog.getByTestId('nas-backup').click();
    const result = dialog.getByTestId('nas-backup-result');
    await result.waitFor();
    const text = await result.innerText();
    assert.match(text, /校验 通过/u, `备份后应自校验通过：${text}`);
    const backupRoot = await fs.readdir(target);
    assert.equal(backupRoot.length, 1, '应生成一个备份目录');
    const manifest = JSON.parse(await fs.readFile(path.join(target, backupRoot[0]!, 'manifest.json'), 'utf8')) as { entries: { path: string; sha256: string }[]; projectName: string };
    assert.ok(manifest.entries.length >= 2);
    assert.ok(manifest.entries.every(entry => /^[a-f0-9]{64}$/u.test(entry.sha256)));
    // 篡改一个文件后校验应报失败（"二次备份换目录"由 nas-backup.test.ts 覆盖）
    const victim = path.join(target, backupRoot[0]!, manifest.entries[0]!.path);
    await fs.writeFile(victim, 'tampered', 'utf8');
    const verify = await page.evaluate(async (dir: string) => window.writer.verifyBackupAt(dir), path.join(target, backupRoot[0]!));
    assert.equal(verify.ok, false);
    assert.ok(verify.mismatch.length >= 1);
    console.log('NAS backup desktop passed: backup created and self-verified, tampering detected on verify.');
  } finally {
    await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {});
    await fs.rm(path.join(fixture, 'app-data'), { recursive: true, force: true }).catch(() => {});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
