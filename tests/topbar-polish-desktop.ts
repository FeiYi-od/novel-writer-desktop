import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/topbar-polish-'));
  const folder = path.join(fixture, '虚构小说'); await fs.mkdir(folder);
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'userdata'); delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args:[path.resolve('out/main/index.js')], env });
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(20000);
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled:false, filePaths:[selected] }); }, folder);
    await page.setViewportSize({width:1000,height:720});
    const version = JSON.parse(await fs.readFile('package.json','utf8')).version as string;
    await page.waitForFunction(value => document.querySelector('[data-testid="app-version"]')?.textContent?.includes(value), version);
    for (const name of ['我的书架','写作空间','角色库','文风研习室','模型设置','保存并退出','＋ 打开小说文件夹']) assert.ok(await page.getByRole('button',{name,exact:true}).isVisible(),name);
    const save = page.getByRole('button',{name:'保存并退出',exact:true});
    const saveColor = await save.evaluate(e => ({ color:getComputedStyle(e).color, border:getComputedStyle(e).borderTopColor }));
    assert.deepEqual(saveColor,{color:'rgb(180, 35, 24)',border:'rgb(180, 35, 24)'});
    await page.getByRole('button',{name:'＋ 打开小说文件夹',exact:true}).click();
    const more = page.getByText('更多功能',{exact:true});
    await more.focus(); await page.keyboard.press('Enter');
    for (const name of ['创作筹备','资料转换','朱雀检测','用量统计','检查更新','知识检索']) assert.ok(await page.getByRole('button',{name,exact:true}).isVisible(),name);
    await page.keyboard.press('Escape');
    assert.equal(await more.evaluate(e => e === document.activeElement),true);
    assert.equal(await page.locator('.topbar-more').evaluate(e => (e as HTMLDetailsElement).open),false);
    await more.click(); await page.getByRole('button',{name:'用量统计',exact:true}).click();
    await page.getByRole('dialog',{name:'用量统计'}).waitFor();
    await page.getByRole('dialog',{name:'用量统计'}).getByRole('button',{name:'关闭'}).click();
    assert.equal(await more.evaluate(e => e === document.activeElement),true);
    await more.click(); await page.getByRole('button',{name:'创作筹备',exact:true}).click();
    await page.getByLabel('筹备构想').waitFor();
    assert.equal(await page.locator('.topbar-more').evaluate(e => (e as HTMLDetailsElement).open),false);
    await page.screenshot({path:path.join(fixture,'topbar-1000.png')});
    await page.setViewportSize({width:1440,height:900});
    await page.screenshot({path:path.join(fixture,'topbar-1440.png')});
    console.log(`Topbar polish desktop passed: ${fixture}`);
  } finally { await app.evaluate(({app:instance}) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
