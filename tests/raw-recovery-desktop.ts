import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// 保存失败的原始副本要能在「恢复本书草稿」页里看到、预览并取回为新章节。
async function main() {
  const fixture = path.resolve('.artifacts', `raw-recovery-desktop-${Date.now()}`), folder = path.join(fixture, '恢复书');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(25000);
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    // 制造一次失败保存：正常保存后把文件改成别的内容，再用旧 hash 保存
    const info = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const chapter = await window.writer.createChapter(id, 'docx');
      const first = await window.writer.readChapter(id, chapter.path);
      const saved = await window.writer.saveChapter({ projectId: id, path: first.path, expectedHash: first.hash,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '　　第一次正常保存。' }] }] } });
      return { id, path: saved.path, hash: saved.hash };
    });
    await fs.writeFile(path.join(folder, info.path), Buffer.from('外部程序写入的内容', 'utf8'));
    const failure = await page.evaluate(async target => {
      try {
        await window.writer.saveChapter({ projectId: target.id, path: target.path, expectedHash: target.hash,
          content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '　　失败时写的另一段正文。' }] }] } });
        return '';
      } catch (error) { return String((error as Error).message ?? error); }
    }, info);
    assert.match(failure, /已被其他程序修改|恢复区/u, `应有可读失败原因：${failure}`);

    // 进入草稿恢复页，找到自动备份并预览、取回
    await page.getByRole('button', { name: '恢复本书草稿' }).click();
    await page.getByRole('heading', { name: '本书草稿恢复' }).waitFor();
    const entry = page.getByTestId('raw-draft').first();
    await entry.waitFor();
    await entry.click();
    const preview = page.getByLabel('自动备份预览');
    await preview.waitFor();
    assert.match(await preview.innerText(), /失败时写的另一段正文/u, '预览应显示失败当时的文字');
    await page.getByTestId('raw-restore').click();
    const note = page.getByTestId('raw-note');
    await note.waitFor();
    const noteText = await note.innerText();
    assert.match(noteText, /已取回为新章节/u, `应提示取回路径：${noteText}`);
    const restoredPath = noteText.replace(/^已取回为新章节：/u, '').trim();
    const bytes = await fs.readFile(path.join(folder, restoredPath));
    assert.ok(bytes.length > 0, '取回的章节文件应存在');
    assert.match(restoredPath, /取回/u);
    // 原稿仍是外部内容，没有被覆盖
    assert.equal((await fs.readFile(path.join(folder, info.path))).toString('utf8'), '外部程序写入的内容');
    console.log('Raw recovery desktop passed: failure copy listed, previewed, restored as a new chapter; original untouched.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
