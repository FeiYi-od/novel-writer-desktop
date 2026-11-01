import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/txt-desktop-061-'));
  const folder = path.join(fixture, '虚构书'); await fs.mkdir(folder);
  const file = path.join(folder, '空段.txt'); const original = '第一段\n\n\n第二段\n'; await fs.writeFile(file, original);
  const env: Record<string,string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'local'); delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron') as string, args: [path.resolve('out/main/index.js')], env });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.locator('.chapter-list button').filter({ hasText: '空段.txt' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.tiptap p').length === 5);
    const before = await page.locator('.tiptap p').allTextContents();
    assert.deepEqual(before, ['　　第一段', '　　', '　　', '　　第二段', '　　']);
    await page.locator('.tiptap p').nth(0).click(); await page.keyboard.press('End'); await page.keyboard.type('X');
    await page.getByRole('button', { name: '保存 TXT', exact: true }).click();
    await page.waitForFunction(async () => !(document.querySelector('button.primary') as HTMLButtonElement | null)?.disabled);
    let stored = await fs.readFile(file, 'utf8');
    for (let attempt = 0; attempt < 50 && !stored.includes('X'); attempt++) { await page.waitForTimeout(100); stored = await fs.readFile(file, 'utf8'); }
    assert.equal(stored, '　　第一段X\n　　\n　　\n　　第二段\n　　');
    await page.locator('.chapter-list button').filter({ hasText: '空段.txt' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.tiptap p').length === 5);
    assert.deepEqual(await page.locator('.tiptap p').allTextContents(), ['　　第一段X', '　　', '　　', '　　第二段', '　　']);
    const id = (await page.evaluate(() => window.writer.listProjects()))[0].id;
    const backups = (await fs.readdir(path.join(fixture, 'local', 'recovery', id))).filter(name => name.endsWith('-previous.txt'));
    assert.ok((await Promise.all(backups.map(name => fs.readFile(path.join(fixture, 'local', 'recovery', id, name), 'utf8')))).includes(original));
    console.log(`TXT empty paragraphs desktop passed: ${fixture}`);
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
