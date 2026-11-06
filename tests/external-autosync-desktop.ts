import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/external-autosync-'));
  const folders = [path.join(fixture, '虚构甲'), path.join(fixture, '虚构乙')];
  await Promise.all(folders.map(folder => fs.mkdir(folder)));
  for (const folder of folders) await fs.writeFile(path.join(folder, '第一章.txt'), '　　原始正文。', 'utf8');
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string,string] => typeof e[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'data'); delete env.ELECTRON_RUN_AS_NODE;
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--exe' && path.isAbsolute(args[1]!)));
  const app = await electron.launch({ executablePath: args.length ? args[1]! : createRequire(import.meta.url)('electron'), args: args.length ? [] : [path.resolve('out/main/index.js')], env });
  try {
    if (args.length) { const identity = await app.evaluate(({app}) => ({ packaged: app.isPackaged, version: app.getVersion() })); assert.equal(identity.packaged, true); assert.equal(identity.version, JSON.parse(await fs.readFile('package.json', 'utf8')).version); }
    const page = await app.firstWindow(); page.setDefaultTimeout(20000);
    const open = async (folder: string) => {
      await app.evaluate(({dialog}, selected) => { dialog.showOpenDialog = async () => ({canceled:false,filePaths:[selected]}); }, folder);
      await page.getByRole('button',{name:'＋ 打开小说文件夹',exact:true}).click();
      await page.getByText(`已打开「${path.basename(folder)}」`,{exact:false}).waitFor();
      await page.locator('.chapter-list').getByRole('button',{name:'第一章.txt'}).click();
      await page.locator('.tiptap').waitFor();
    };
    await open(folders[0]!); await page.waitForTimeout(700);
    await fs.writeFile(path.join(folders[0]!, '第一章.txt'), '　　外部更新正文。', 'utf8');
    await page.getByText('已自动读取磁盘上的最新正文',{exact:true}).waitFor();
    assert.match(await page.locator('.tiptap').innerText(), /外部更新正文/);
    assert.equal(await page.getByText(/检测到章节文件变化/u).count(), 0);
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as any)._invokeHandlers as Map<string, (...args: any[]) => Promise<unknown>>;
      const original = handlers.get('chapters:read');
      if (!original) throw new Error('章节读取处理器不存在');
      handlers.set('chapters:read', async (...args: any[]) => {
        handlers.set('chapters:read', original);
        const value = await original(...args);
        (globalThis as any).__autosyncReadPaused = true;
        await new Promise<void>(resolve => { (globalThis as any).__autosyncRelease = resolve; });
        return value;
      });
    });
    await fs.writeFile(path.join(folders[0]!, '第一章.txt'), '　　外部另一份修改。', 'utf8');
    let paused = false;
    for (let i = 0; i < 100 && !paused; i++) { paused = await app.evaluate(() => Boolean((globalThis as any).__autosyncReadPaused)); if (!paused) await page.waitForTimeout(100); }
    assert.equal(paused, true, '外部读取必须在测试中暂停，才能验证期间输入');
    await page.locator('.tiptap').fill('　　本机尚未保存的修改。');
    await app.evaluate(() => (globalThis as any).__autosyncRelease());
    await page.getByText(/检测到章节文件变化/u).waitFor();
    assert.match(await page.locator('.tiptap').innerText(), /本机尚未保存的修改/);
    assert.equal(await fs.readFile(path.join(folders[0]!, '第一章.txt'), 'utf8'), '　　外部另一份修改。');
    page.once('dialog', dialog => void dialog.accept());
    await open(folders[1]!);
    await fs.writeFile(path.join(folders[0]!, '第一章.txt'), '　　甲书的后续变更。', 'utf8');
    await page.waitForTimeout(700);
    assert.match(await page.locator('.tiptap').innerText(), /原始正文/);
    assert.equal(await page.getByText(/检测到章节文件变化/u).count(), 0, '切书后旧书事件不得污染当前书');
    console.log(`External autosync desktop passed: ${fixture}`);
  } finally { await app.evaluate(({app})=>app.exit(0)).catch(()=>{}); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
