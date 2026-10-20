import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// 保存状态必须诚实：没保存过就显示"尚未保存"；保存成功；冲突时拒写并留本机草稿。
// 状态条文案切换规则由 tests/save-status.test.ts 覆盖，这里验证真实运行时的保存与草稿行为。
async function main() {
  const fixture = path.resolve('.artifacts', `save-badge-desktop-${Date.now()}`), folder = path.join(fixture, '状态书');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(25000);
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    const badge = page.getByTestId('save-badge');
    await badge.waitFor();
    assert.match(await badge.innerText(), /尚未保存/u, '没保存过就不能说已保存');

    const info = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const chapter = await window.writer.createChapter(id, 'docx');
      const manuscript = await window.writer.readChapter(id, chapter.path);
      const saved = await window.writer.saveChapter({ projectId: id, path: manuscript.path, expectedHash: manuscript.hash,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '　　状态栏测试正文。' }] }] } });
      return { id, path: saved.path, hash: saved.hash };
    });
    assert.match(String(info.path), /\.docx$/u);

    await fs.writeFile(path.join(folder, info.path), Buffer.from('外部程序写入的内容', 'utf8'));
    const failureText = await page.evaluate(async target => {
      try {
        await window.writer.saveChapter({ projectId: target.id, path: target.path, expectedHash: target.hash,
          content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '　　这次应当被拒绝。' }] }] } });
        return '';
      } catch (error) { return String((error as Error).message ?? error); }
    }, info);
    assert.match(failureText, /已被其他程序修改|恢复区|网络目录/u, `失败文案应可读：${failureText}`);
    const drafts = await fs.readdir(path.join(fixture, 'app-data', 'recovery', info.id)).catch(() => [] as string[]);
    assert.ok(drafts.some(name => /-draft\./u.test(name)), '失败时本机必须留有草稿');
    console.log('Save badge desktop passed: initial label honest, save works, conflicting write refused with readable reason and a local draft kept.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
