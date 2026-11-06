import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// 长章节文件名单行省略、行高一致（复现用户截图里的《校花同桌是我的小母狗（1）.docx》）
async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/chapter-list-ui-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(30000);
    page.on('dialog', dialog => { dialog.accept().catch(() => {}); });
    const projectId = await page.evaluate(async parentDir => (await window.writer.createProject(parentDir, '正文', true)).project.id, parent);
    const chapters = path.join(parent, '正文', '正文');
    await fs.mkdir(chapters, { recursive: true });
    for (const name of ['校花同桌是我的小母狗（1）.docx', '校花同桌是我的小母狗（2）.docx', '短名.docx']) {
      await fs.writeFile(path.join(chapters, name), '');
    }
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, path.join(parent, '正文'));
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    const first = page.locator('.chapter-list button').first();
    await first.waitFor({ timeout: 20000 });
    const metrics = await page.locator('.chapter-list').evaluate(list => {
      const rows = [...list.querySelectorAll('button')].map(button => {
        const name = button.querySelector('.chapter-name') as HTMLElement;
        return { height: Math.round(button.getBoundingClientRect().height), name: name?.textContent ?? '', textOverflow: name ? getComputedStyle(name).textOverflow : '', scroll: name ? name.scrollWidth : 0, client: name ? name.clientWidth : 0, title: button.getAttribute('title') };
      });
      return rows;
    });
    const tall = metrics.find(row => row.height > 44);
    assert.equal(tall, undefined, '章节行不应换成多行：' + JSON.stringify(metrics));
    const long = metrics.find(row => row.name.includes('（1）'));
    assert.ok(long, '应列出长文件名');
    assert.equal(long.textOverflow, 'ellipsis');
    assert.ok(long.scroll > long.client, '长文件名应被省略');
    assert.ok(long.title?.includes('校花同桌是我的小母狗（1）.docx'), 'title 应保留完整路径');
    await page.locator('.sidebar').screenshot({ path: path.join(fixture, 'chapter-list.png') });
    console.log(`Chapter list UI passed: ${JSON.stringify(metrics)} 截图 ${path.join(fixture, 'chapter-list.png')}`);
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
