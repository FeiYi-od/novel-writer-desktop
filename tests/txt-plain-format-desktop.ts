import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
async function main() {
 const fixture = await fs.mkdtemp(path.resolve('.artifacts/txt-plain-desktop-')); const folder=path.join(fixture,'虚构书'); await fs.mkdir(folder); const file=path.join(folder,'第一章.txt'); await fs.writeFile(file,'　　原始正文。');
 const env: Record<string,string>=Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>typeof e[1]==='string')); env.NOVEL_WRITER_TEST_DATA=path.join(fixture,'data'); delete env.ELECTRON_RUN_AS_NODE;
 const args=process.argv.slice(2); assert.ok(args.length===0 || (args.length===2 && args[0]==='--exe' && path.isAbsolute(args[1]!)));
 const app=await electron.launch({executablePath:args.length?args[1]!:createRequire(import.meta.url)('electron'),args:args.length?[]:[path.resolve('out/main/index.js')],env});
 try { const page=await app.firstWindow();page.setDefaultTimeout(30000);await app.evaluate(({dialog},selected)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[selected]});},folder); await page.getByRole('button',{name:'＋ 打开小说文件夹',exact:true}).click();await page.getByText('已打开「虚构书」',{exact:false}).waitFor();await page.locator('.chapter-list').getByRole('button',{name:'第一章.txt'}).click();const ed=page.locator('.tiptap');await ed.click();await page.keyboard.press('End');await page.keyboard.press('Control+b');await page.keyboard.type('BOLD');await page.keyboard.press('Control+i');await page.keyboard.type('ITALIC');await page.keyboard.press('Control+Alt+1');
 await ed.evaluate(el=>{const data=new DataTransfer();data.setData('text/plain','粘贴文字');data.setData('text/html','<h1><strong>粘贴文字</strong></h1>');el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));});
 const html=await ed.innerHTML();assert.doesNotMatch(html,/<strong|<em|<h[1-6]/i);assert.match(html,/粘贴文字/);
 await page.getByRole('button',{name:'保存 TXT',exact:true}).click();await page.getByText('TXT 已保存到所选文件夹',{exact:true}).waitFor();const saved=await fs.readFile(file,'utf8');assert.match(saved,/BOLDITALIC/);assert.match(saved,/粘贴文字/);assert.ok(saved.startsWith('　　'));
 await page.getByRole('button',{name:'＋ 新建 DOCX 章节'}).click();await page.getByText('已新建 DOCX · 宋体五号', { exact: true }).waitFor();const doc=page.locator('.tiptap');await doc.fill('对照正文');await doc.click();await page.keyboard.press('End');await page.keyboard.press('Control+b');await page.keyboard.type('BOLD');assert.match(await doc.innerHTML(),/<strong>/i); console.log('TXT plain desktop passed: keyboard and rich paste stay plain, save preserves text; DOCX bold remains available.');
 } finally {await app.evaluate(({app:instance})=>instance.exit(0));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
