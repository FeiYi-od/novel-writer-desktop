import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main(){
  const fixture=path.resolve('.artifacts',`models-desktop-${Date.now()}`);await fs.mkdir(fixture,{recursive:true});let supported=true;const calls:{method:string;url:string;auth:string}[]=[];const server=createServer((req,res)=>{calls.push({method:req.method!,url:req.url!,auth:req.headers.authorization??''});res.setHeader('Content-Type','application/json');if(!supported){res.statusCode=404;res.end('do-not-show-test-secret');return;}res.end(JSON.stringify({data:[{id:'test-writer',name:'模拟写作模型',context_window:65536},{id:'test-reviewer',name:'模拟审稿模型'}]}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}`;
  const require=createRequire(import.meta.url),app=await electron.launch({executablePath:require('electron'),args:[path.resolve('out/main/index.js')],env:{...process.env,NOVEL_WRITER_TEST_DATA:path.join(fixture,'app-data')}});const page=await app.firstWindow();page.setDefaultTimeout(15000);
  try{
    await page.getByRole('button',{name:'模型设置',exact:true}).click();await page.getByLabel('连接名称',{exact:true}).fill('模拟模型目录');await page.getByLabel('API 基础地址',{exact:true}).fill(url+'/v1');await page.getByLabel('API 密钥',{exact:true}).fill('test-secret');assert.equal(await page.getByLabel('模型名称',{exact:true}).inputValue(),'');
    await page.getByRole('button',{name:'获取模型列表',exact:true}).click();await page.getByText('模型列表已获取，请选择或手工填写',{exact:true}).waitFor();await page.getByLabel('服务商模型列表').selectOption('test-writer');assert.equal(await page.getByLabel('模型名称',{exact:true}).inputValue(),'test-writer');assert.equal(await page.getByLabel('上下文窗口',{exact:true}).inputValue(),'32768');assert.equal(await page.getByLabel('最大输出 token',{exact:true}).inputValue(),'4096');// 「服务声明窗口」文案已在能力面板改造中移除，这里改为确认窗口与输出上限已按服务商建议填好（上面两条断言）。
    await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64'));await fs.writeFile(path.resolve('.artifacts/model-discovery.png'),Buffer.from(png,'base64'));
    await page.getByRole('button',{name:'保存模型连接',exact:true}).click();await page.getByText('模型连接已保存',{exact:true}).waitFor();assert.equal(await page.getByLabel('API 密钥',{exact:true}).inputValue(),'');await page.getByRole('button',{name:'获取模型列表',exact:true}).click();await page.getByLabel('服务商模型列表').waitFor();assert.ok(calls.every(call=>call.method==='GET'&&call.url==='/v1/models'&&call.auth==='Bearer test-secret'));
    supported=false; /* 模型目录有 24h 缓存：先删缓存，才能真的走到失败路径 */ await fs.rm(path.join(fixture,'app-data','model-cache.json'),{force:true});await page.getByTestId('models-refresh').click();await page.getByRole('alert').first().waitFor();assert.equal(await page.getByLabel('模型名称',{exact:true}).inputValue(),'test-writer');assert.ok(!(await page.getByRole('alert').innerText()).includes('do-not-show-test-secret'));
    await page.getByLabel('模型名称',{exact:true}).fill('manual-model');await page.getByRole('button',{name:'保存模型连接',exact:true}).click();await page.getByText('模型连接已保存',{exact:true}).waitFor();assert.equal((await page.evaluate(()=>window.writer.aiConnections())).connections[0].model,'manual-model');
    console.log('Models desktop passed: unsaved credential discovery, selection/manual fallback, no capability guessing, encrypted saved key use and GET-only requests.');
  }finally{await app.evaluate(({app:instance})=>instance.exit(0)).catch(()=>{});await new Promise<void>(r=>server.close(()=>r()));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
