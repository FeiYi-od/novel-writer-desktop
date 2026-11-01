import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--exe' && path.isAbsolute(args[1]!)), 'Usage: tsx tests/ui-drafts-safety-desktop.ts [--exe <absolute packaged exe>]');

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/ui-draft-safety-060-'));
  const folder = path.join(fixture, '虚构资料小说'); await fs.mkdir(folder);
  const env: Record<string,string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'local'); delete env.ELECTRON_RUN_AS_NODE;
  const executable = args.length ? path.resolve(args[1]!) : createRequire(import.meta.url)('electron') as string;
  let app!: ElectronApplication; let page!: Page;
  const launch = async () => {
    app = await electron.launch({ executablePath: executable, args: args.length ? [] : [path.resolve('out/main/index.js')], env });
    if (args.length) {
      const expectedVersion = JSON.parse(await fs.readFile('package.json', 'utf8')).version as string;
      const identity = await app.evaluate(({ app: instance }) => ({ packaged: instance.isPackaged, version: instance.getVersion(), path: instance.getAppPath() }));
      assert.equal(identity.packaged, true); assert.equal(identity.version, expectedVersion);
      assert.equal(await fs.realpath(identity.path), await fs.realpath(path.join(path.dirname(executable), 'resources/app.asar')));
    }
    page = await app.firstWindow(); page.setDefaultTimeout(20000);
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByText('更多功能', { exact: true }).click(); await page.getByRole('button', { name: '资料转换', exact: true }).click();
    await page.getByLabel('转换原文').waitFor();
  };
  const text = 'A'.repeat(100000), preview = 'B'.repeat(100000);
  await launch();
  try {
    await page.getByLabel('转换原文').fill(text);
    await page.getByLabel('Markdown 资料预览').fill(preview);
    let saved = false;
    for (let attempt = 0; attempt < 60 && !saved; attempt++) {
      await page.waitForTimeout(100);
      saved = await page.evaluate(async () => {
        const id = (await window.writer.listProjects())[0]?.id;
        const draft = id ? await window.writer.readUiDraft(id, 'materials') : null;
        return Boolean(draft?.values.doc && draft.values.doc.length > 200000 && JSON.parse(draft.values.doc).preview?.length === 100000);
      });
    }
    assert.equal(saved, true, '草稿应实际写入并能解析');
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
  await launch();
  try {
    await page.getByRole('button', { name: '恢复上次草稿', exact: true }).click();
    assert.equal(await page.getByLabel('转换原文').inputValue(), text);
    assert.equal(await page.getByLabel('Markdown 资料预览').inputValue(), preview);
    await app.evaluate(() => {
      const fs = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises');
      const original = fs.writeFile;
      (fs as any).writeFile = async (...args: any[]) => {
        if (String(args[0]).includes('ui-drafts')) throw new Error('虚构备份故障');
        return (original as any)(...args);
      };
    });
    const changed = 'C'.repeat(100000);
    await page.getByLabel('转换原文').fill(changed);
    await page.getByRole('alert').filter({ hasText: '未保存草稿自动备份失败' }).waitFor();
    await page.getByRole('button', { name: '保存并退出', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '保存并退出未完成' }).first().waitFor();
    assert.equal(app.process().exitCode, null);
    assert.equal(await page.getByLabel('转换原文').inputValue(), changed);
    const id = (await page.evaluate(() => window.writer.listProjects()))[0].id;
    const previous = await page.evaluate(projectId => window.writer.readUiDraft(projectId, 'materials'), id);
    assert.equal(JSON.parse(previous!.values.doc).source, text);
    console.log(`UI draft safety desktop passed: ${fixture}`);
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
