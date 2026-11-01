import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--exe' && path.isAbsolute(args[1]!)), 'Usage: tsx tests/chapter-save-race-desktop.ts [--exe <absolute packaged exe>]');
const executable = args.length ? path.resolve(args[1]!) : createRequire(import.meta.url)('electron') as string;

async function check(format: 'docx' | 'txt') {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/save-race-desktop-059-'));
  const folder = path.join(fixture, '虚构书'); await fs.mkdir(folder);
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'data'); delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: executable, args: args.length ? [] : [path.resolve('out/main/index.js')], env });
  const page = await app.firstWindow(); page.setDefaultTimeout(25000);
  try {
    if (args.length) {
      const expectedVersion = JSON.parse(await fs.readFile('package.json', 'utf8')).version as string;
      const identity = await app.evaluate(({ app: instance }) => ({ packaged: instance.isPackaged, version: instance.getVersion(), path: instance.getAppPath() }));
      assert.equal(identity.packaged, true); assert.equal(identity.version, expectedVersion);
      assert.equal(await fs.realpath(identity.path), await fs.realpath(path.join(path.dirname(executable), 'resources/app.asar')));
    }
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByLabel('新章节格式').selectOption(format);
    await page.getByRole('button', { name: `＋ 新建 ${format.toUpperCase()} 章节`, exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.tiptap')?.getAttribute('contenteditable') === 'true');
    const id = await page.evaluate(async () => (await window.writer.listProjects())[0].id);
    const files = (await fs.readdir(folder)).filter(name => name.toLowerCase().endsWith(`.${format}`)); assert.equal(files.length, 1);
    const file = path.join(folder, files[0]), external = '虚构外部更新原字节';
    await page.locator('.tiptap').click(); await page.keyboard.insertText('界面未保存稿件');
    await app.evaluate((_electron, spec) => {
      const fs = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises');
      const original = fs.writeFile;
      (fs as any).writeFile = async (...args: any[]) => {
        const result = await (original as any)(...args), target = String(args[0]);
        if (target.startsWith(`${spec.file}.`) && target.endsWith('.tmp')) {
          (fs as any).writeFile = original; await original(spec.file, spec.external, 'utf8');
          (globalThis as any).__raceInjected = true;
        }
        return result;
      };
    }, { file, external });
    await page.getByRole('button', { name: `保存 ${format.toUpperCase()}`, exact: true }).click();
    await page.getByText(/保存期间文件发生变化/u).first().waitFor();
    assert.equal(await app.evaluate(() => Boolean((globalThis as any).__raceInjected)), true);
    assert.equal(await fs.readFile(file, 'utf8'), external, '外部更新不得被覆盖');
    assert.match(await page.locator('.tiptap').innerText(), /界面未保存稿件/u);
    const recovered = await fs.readdir(path.join(fixture, 'data', 'recovery', id));
    assert.ok(recovered.some(name => name.endsWith(`-draft.${format}`)), '本机恢复区保留草稿');
    await page.getByRole('button', { name: '保存并退出', exact: true }).click();
    await page.getByText(/保存并退出未完成/u).first().waitFor();
    assert.equal(app.process().exitCode, null); assert.equal(await fs.readFile(file, 'utf8'), external);
    assert.match(await page.locator('.tiptap').innerText(), /界面未保存稿件/u);
    console.log(`Chapter save race desktop ${format} passed: ${fixture}`);
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
async function main() { await check('docx'); await check('txt'); }
main().catch(error => { console.error(error); process.exitCode = 1; });
