import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// 本书健康检查：面板里点一下就能看到"哪些章节被外部改过/是空文件"，而且只读。
async function main() {
  const fixture = path.resolve('.artifacts', `book-health-desktop-${Date.now()}`), folder = path.join(fixture, '体检书');
  await fs.mkdir(folder, { recursive: true });
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(25000);
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    const info = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const chapter = await window.writer.createChapter(id, 'docx');
      const manuscript = await window.writer.readChapter(id, chapter.path);
      await window.writer.saveChapter({ projectId: id, path: manuscript.path, expectedHash: manuscript.hash,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '　　体检用正文。' }] }] } });
      return { id, path: manuscript.path };
    });
    await page.getByTestId('nas-open').click();
    const dialog = page.getByRole('dialog', { name: 'NAS 连接检查' });
    await dialog.waitFor();
    // 正常状态：没有发现问题
    await dialog.getByTestId('book-health').click();
    const result = dialog.getByTestId('book-health-result');
    await result.waitFor();
    assert.match(await result.innerText(), /检查了 \d+ 章，没有发现问题/u, `正常书应无问题：${await result.innerText()}`);

    // 制造外部改动 → 应报"没有保存记录"
    await fs.writeFile(path.join(folder, info.path), Buffer.from('外部写入的内容', 'utf8'));
    await dialog.getByTestId('book-health').click();
    await page.waitForFunction(() => /没有保存记录|发现 \d+ 个问题/u.test(document.querySelector('[data-testid="book-health-result"]')?.textContent ?? ''), undefined, { timeout: 15000 });
    const changed = await result.innerText();
    assert.match(changed, /没有保存记录|发现 \d+ 个问题/u, `应报告外部改动：${changed}`);
    // 只读：文件内容没被改
    assert.equal((await fs.readFile(path.join(folder, info.path))).toString('utf8'), '外部写入的内容');
    console.log('Book health desktop passed: clean book reported clean, externally changed chapter flagged, files untouched.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
