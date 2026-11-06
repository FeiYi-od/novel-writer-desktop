import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const executable = String.raw`${process.env.LOCALAPPDATA}\Programs\Starwriting\beta.30\小说编写器.exe`;

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/packaged-beta30-style-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const corpus = path.join(fixture, '语料.txt'); await fs.writeFile(corpus, '　　长句叙述，细节密实。'.repeat(400), 'utf8');
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  try {
    app = await electron.launch({ executablePath: executable, args: [], env, timeout: 60000 });
    const identity = await app.evaluate(({ app: instance }) => ({ version: instance.getVersion(), packaged: instance.isPackaged }));
    assert.equal(identity.version, '0.1.1-beta.30');
    page = await app.firstWindow({ timeout: 45000 }); page.setDefaultTimeout(30000);
    page.on('dialog', dialog => { dialog.accept().catch(() => {}); });
    const projectId = await page.evaluate(async parentDir => (await window.writer.createProject(parentDir, '巡检书', true)).project.id, parent);
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, corpus);
    await page.evaluate(async id => { const book = await window.writer.readBook(id); await window.writer.importStyleSources(id, book.hash); }, projectId);
    await page.evaluate(async id => {
      let book = await window.writer.readBook(id);
      const source = book.value.sources[0]!.id;
      await window.writer.analyzeStyle(id, '文风甲', [source], book.hash, { mode: 'sample' });
      book = await window.writer.readBook(id);
      await window.writer.analyzeStyle(id, '文风乙', [source], book.hash, { mode: 'sample' });
    }, projectId);
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, path.join(parent, '巡检书'));
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    const results: unknown[] = [];
    for (const label of ['文风试写比较…', '文风版本与效果…']) {
      await page.getByRole('button', { name: label }).click();
      const modal = page.locator('.book-modal').last();
      await modal.waitFor({ timeout: 15000 });
      const metrics = await modal.evaluate(element => {
        const box = element as HTMLElement;
        return { width: Math.round(box.getBoundingClientRect().width), height: Math.round(box.getBoundingClientRect().height), overflow: box.scrollWidth - box.clientWidth };
      });
      assert.equal(metrics.width, 820, label + ' 宽度');
      assert.equal(metrics.overflow, 0);
      results.push({ label, ...metrics });
      await page.screenshot({ path: path.join(fixture, label.replace('…', '') + '.png') });
      await modal.getByRole('button', { name: '关闭' }).first().click().catch(() => {});
      await page.waitForTimeout(250);
    }
    console.log(JSON.stringify({ ok: true, identity, results, fixture }));
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
