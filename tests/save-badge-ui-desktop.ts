import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// A07：保存状态条必须真的跟着保存结果变——成功变「已保存」，失败变「上次保存失败（草稿在本机恢复区）」。
async function main() {
  const fixture = path.resolve('.artifacts', `badge-ui-${Date.now()}`), folder = path.join(fixture, '状态书'), otherFolder = path.join(fixture, '另一书');
  await Promise.all([fs.mkdir(folder, { recursive: true }), fs.mkdir(otherFolder, { recursive: true })]);
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(25000);
  const badgeText = async () => (await page.getByTestId('save-badge').innerText()).trim();
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
    // 用界面按钮建章并打开编辑器
    await page.evaluate(() => {
      const create = [...document.querySelectorAll('button')].find(button => (button.textContent ?? '').includes('新建 DOCX 章节'));
      create?.click();
    });
    await page.waitForFunction(() => document.querySelector('.tiptap')?.getAttribute('contenteditable') === 'true', undefined, { timeout: 20000 });
    assert.match(await badgeText(), /尚未保存/u, '打开新章节时应显示尚未保存');

    // 打字 → 保存：徽标应变成已保存
    await page.locator('.tiptap').click({ position: { x: 20, y: 20 } });
    await page.keyboard.type('状态条联动测试。');
    await page.getByRole('button', { name: '保存 DOCX', exact: true }).click();
    await page.waitForFunction(() => /已保存到所选文件夹/u.test(document.querySelector('[data-testid="save-badge"]')?.textContent ?? ''), undefined, { timeout: 20000 });

    // 外部改动 → 再保存：徽标应变成失败，并且按钮可点进恢复页
    const info = await page.evaluate(async () => {
      const id = (await window.writer.listProjects())[0].id;
      const chapters = await window.writer.chapters(id);
      const manuscript = await window.writer.readChapter(id, chapters[0].path);
      return { id, path: manuscript.path };
    });
    await fs.writeFile(path.join(folder, info.path), Buffer.from('外部程序写入的内容', 'utf8'));
    await page.waitForFunction(() => document.querySelector('.tiptap')?.getAttribute('contenteditable') === 'true');
    await page.locator('.tiptap').click();
    await page.keyboard.type('再写一句。');
    await page.getByRole('button', { name: '保存 DOCX', exact: true }).click();
    await page.waitForFunction(() => /上次保存失败/u.test(document.querySelector('[data-testid="save-badge"]')?.textContent ?? ''), undefined, { timeout: 20000 });
    assert.match(await badgeText(), /恢复区/u, '失败徽标要说明草稿在哪');
    await page.getByTestId('save-badge').click();
    await page.getByRole('heading', { name: '本书草稿恢复' }).waitFor({ timeout: 15000 });

    // 切到另一本书/章节，不继承前书失败或成功；自动保存也要更新徽标。
    page.on('dialog', dialog => void dialog.accept());
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, otherFolder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
    await page.waitForFunction(() => document.querySelector('.project-heading')?.textContent === '另一书');
    assert.match(await badgeText(), /尚未保存/u, '切书不能显示上一书的保存结果');
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).click();
    await page.waitForFunction(() => document.querySelector('.tiptap')?.getAttribute('contenteditable') === 'true');
    const autoSave = page.getByRole('checkbox', { name: '自动保存正文' });
    await autoSave.check();
    await page.locator('.tiptap').click();
    await page.keyboard.type('自动保存成功后应更新徽标。');
    await page.waitForFunction(() => /已保存到所选文件夹/u.test(document.querySelector('[data-testid="save-badge"]')?.textContent ?? ''), undefined, { timeout: 15000 });

    // 自动保存仅保存发起时的版本，迟到成功不能把保存期间新输入的文字标成已保存。
    await app.evaluate(({ ipcMain }) => {
      const state = globalThis as typeof globalThis & { __badgeSaveStarted?: boolean; __badgeRelease?: () => void };
      const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers.get('chapters:save')!;
      state.__badgeSaveStarted = false;
      ipcMain.removeHandler('chapters:save');
      ipcMain.handle('chapters:save', async (event, ...args) => {
        ipcMain.removeHandler('chapters:save'); ipcMain.handle('chapters:save', original);
        state.__badgeSaveStarted = true;
        await new Promise<void>(resolve => { state.__badgeRelease = resolve; });
        return original(event, ...args);
      });
    });
    await page.locator('.tiptap').click(); await page.keyboard.type('这句在自动保存快照里。');
    await app.evaluate(async () => {
      const startedAt = Date.now();
      while (!(globalThis as typeof globalThis & { __badgeSaveStarted?: boolean }).__badgeSaveStarted) {
        if (Date.now() - startedAt > 15000) throw new Error('自动保存未发起');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    });
    await page.locator('.tiptap').click(); await page.keyboard.type('这句在保存期间继续输入。');
    await app.evaluate(() => (globalThis as typeof globalThis & { __badgeRelease?: () => void }).__badgeRelease?.());
    await page.waitForFunction(() => !document.querySelector('footer')?.textContent?.includes('自动保存中'));
    assert.match(await badgeText(), /正文有未保存修改/u, '迟到的自动保存成功不能把新输入标为已保存');
    assert.match(await page.locator('.tiptap').innerText(), /这句在保存期间继续输入/u, '保存不能覆盖正在写的新文字');
    await autoSave.uncheck();
    await page.locator('.tiptap').click();
    await page.keyboard.type('保存后继续写作仍未保存。');
    await page.waitForFunction(() => /正文有未保存修改/u.test(document.querySelector('[data-testid="save-badge"]')?.textContent ?? ''));
    await page.getByRole('button', { name: '保存 DOCX', exact: true }).click();
    await page.waitForFunction(() => /已保存到所选文件夹/u.test(document.querySelector('[data-testid="save-badge"]')?.textContent ?? ''));

    // checkpoint 自身失败时也要反馈；不能仅因错误中提到“恢复区”就声称已保留。
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('recovery:checkpoint');
      ipcMain.handle('recovery:checkpoint', () => { throw new Error('测试恢复区不可用，写入失败'); });
    });
    await page.locator('.tiptap').click(); await page.keyboard.type('暂存失败测试。');
    await page.getByRole('button', { name: '保存 DOCX', exact: true }).click();
    await page.waitForFunction(() => /上次保存失败/u.test(document.querySelector('[data-testid="save-badge"]')?.textContent ?? ''));
    assert.doesNotMatch(await badgeText(), /草稿在本机恢复区/u, '暂存失败不能显示草稿已保存');
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).click();
    await page.waitForFunction(() => /尚未保存/u.test(document.querySelector('[data-testid="save-badge"]')?.textContent ?? ''));
    await page.locator('.tiptap').click(); await page.keyboard.type('保存退出暂存失败。');
    await page.getByRole('button', { name: '保存并退出', exact: true }).click();
    await page.waitForFunction(() => /上次保存失败/u.test(document.querySelector('[data-testid="save-badge"]')?.textContent ?? ''));
    assert.doesNotMatch(await badgeText(), /草稿在本机恢复区/u);
    assert.equal(await page.locator('.tiptap').getAttribute('contenteditable'), 'true', '退出失败后保留窗口与未保存正文');
    console.log('Save badge UI desktop passed: manual and automatic results, unsaved edits, book/session isolation, checkpoint failure and save-exit failure.');
  } finally { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
