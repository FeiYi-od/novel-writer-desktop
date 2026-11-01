import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/model-settings-race-desktop-060-'));
  const data = path.join(fixture, 'data');
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = data; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [path.resolve('out/main/index.js')], env });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  try {
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByLabel('连接名称', { exact: true }).fill('虚构初始连接');
    await page.getByLabel('API 基础地址', { exact: true }).fill('https://example.org/v1');
    await page.getByLabel('模型名称', { exact: true }).fill('fictional-model');
    await page.getByRole('button', { name: '保存模型连接', exact: true }).click();
    await page.getByText('模型连接已保存', { exact: true }).waitFor();
    const file = path.join(data, 'ai-connections.json'), previous = await fs.readFile(file, 'utf8');
    const external = JSON.stringify({ schemaVersion: 1, connections: [] });
    await page.getByLabel('连接名称', { exact: true }).fill('虚构未保存编辑');
    await app.evaluate((_electron, spec) => {
      const native = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises');
      const original = native.writeFile;
      (native as any).writeFile = async (...args: any[]) => {
        const result = await (original as any)(...args);
        if (String(args[0]) === `${spec.file}.backup`) {
          (native as any).writeFile = original;
          await original(spec.file, spec.external, 'utf8');
          (globalThis as any).__settingsRaceInjected = true;
        }
        return result;
      };
    }, { file, external });
    await page.getByRole('button', { name: '保存模型连接', exact: true }).click();
    await page.getByText(/AI 连接文件在保存期间被修改/u).first().waitFor();
    assert.equal(await app.evaluate(() => Boolean((globalThis as any).__settingsRaceInjected)), true);
    assert.equal(await fs.readFile(file, 'utf8'), external, '必须保留外部修改');
    assert.equal(await fs.readFile(`${file}.backup`, 'utf8'), previous, '换前备份应保留');
    assert.equal(await page.getByLabel('连接名称', { exact: true }).inputValue(), '虚构未保存编辑');
    assert.equal(app.process().exitCode, null); assert.equal(page.isClosed(), false);
    console.log(`Model settings race desktop passed: ${fixture}`);
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
