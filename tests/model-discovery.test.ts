import { listenLocalHttp } from './support/local-http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { AIConnections } from '../src/main/ai-connections';
import { ModelDiscoveryService } from '../src/main/model-discovery';

test('模型列表实际GET：去重、窗口来源、未保存查询、已存密钥和端点变更保护', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-model-test-')); t.after(async () => { assert.match(path.relative(os.tmpdir(), root), /^novel-model-test-[^\\/]+$/); await fs.rm(root, { recursive: true, force: true }); });
  const requests: { url: string; auth: string; method: string }[] = [];
  const server = createServer((req, res) => { requests.push({ url: req.url!, auth: req.headers.authorization ?? '', method: req.method! }); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: '国内-writer', name: '写作模型', context_window: 65536, max_output_tokens: 8192 }, { id: '国内-writer' }, { id: 'reviewer' }] })); }); await listenLocalHttp(server); t.after(() => new Promise<void>(r => server.close(() => r())));
  const url = `http://127.0.0.1:${(server.address() as any).port}`, connections = new AIConnections(root, { encrypt: s => Buffer.from(s), decrypt: b => b.toString() }), service = new ModelDiscoveryService(connections);
  const first = await service.discover({ expectedHash: '', baseUrl: url + '/v1/chat/completions', apiKey: 'test-secret' }); assert.equal(first.models.length, 2); assert.equal(first.models[0].contextWindow, 65536); assert.ok(!JSON.stringify(first).includes('test-secret')); assert.deepEqual(requests[0], { url: '/v1/models', auth: 'Bearer test-secret', method: 'GET' });
  const saved = await connections.save({ name: '测试', baseUrl: url, model: '手工ID', apiKey: 'stored-secret', adapter: 'deepseek', thinking: 'default', timeoutSeconds: 30, contextWindow: 32768, maxOutputTokens: 4096, tokenParameter: 'max_tokens' }, '');
  await service.discover({ connectionId: saved.connections[0].id, expectedHash: saved.hash, baseUrl: url }); assert.equal(requests.at(-1)!.url, '/models'); assert.equal(requests.at(-1)!.auth, 'Bearer stored-secret');
  const count = requests.length; await assert.rejects(service.discover({ connectionId: saved.connections[0].id, expectedHash: saved.hash, baseUrl: url + '/other' }), /更换地址/); assert.equal(requests.length, count);
  await service.discover({ connectionId: saved.connections[0].id, expectedHash: saved.hash, baseUrl: url + '/other', clearKey: true }); assert.equal(requests.at(-1)!.auth, ''); assert.equal(requests.at(-1)!.url, '/other/models'); await service.discover({ connectionId: saved.connections[0].id, expectedHash: saved.hash, baseUrl: url, clearKey: true, apiKey: 'new-explicit-key' }); assert.equal(requests.at(-1)!.auth, 'Bearer new-explicit-key'); assert.equal((await connections.read()).connections[0].model, '手工ID');
});

test('列表错误/泄密/重定向/超限/超时不返回原始响应，失败不改变配置', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-model-test-')); t.after(async () => { assert.match(path.relative(os.tmpdir(), root), /^novel-model-test-[^\\/]+$/); await fs.rm(root, { recursive: true, force: true }); }); let mode = 'unsupported', redirects = 0;
  const server = createServer((req,res) => { if (req.url === '/redirected') { redirects++; res.end('{}'); return; } if (mode === 'redirect') { res.writeHead(302,{Location:'/redirected'}); res.end(); return; } if (mode === 'slow') { setTimeout(() => res.end('{}'),150); return; } if (mode === 'unsupported') { res.statusCode=404;res.end('echo-secret'); return; } res.setHeader('Content-Type','application/json'); res.end(mode === 'echo' ? JSON.stringify({data:[{id:'echo-secret'}]}) : mode === 'large' ? ' '.repeat(1024*1024+1) : mode === 'empty' ? '{"data":[]}' : '{"models":["bad"]}'); }); await listenLocalHttp(server); t.after(()=>new Promise<void>(r=>server.close(()=>r())));
  const url=`http://127.0.0.1:${(server.address() as any).port}`, connections=new AIConnections(root,{encrypt:s=>Buffer.from(s),decrypt:b=>b.toString()}), service=new ModelDiscoveryService(connections,60); const request={baseUrl:url,expectedHash:'',apiKey:'echo-secret'};
  for (const next of ['unsupported','echo','redirect','large','bad','slow']) { mode=next; await assert.rejects(service.discover(request), e=>e instanceof Error && !e.message.includes('echo-secret')); }
  assert.equal(redirects,0); assert.equal((await connections.read()).hash,''); mode='empty'; assert.equal((await service.discover(request)).models.length,0);
});

test('列表请求固定配置，运行中更改连接使旧结果失效', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'novel-model-test-'));t.after(async()=>{assert.match(path.relative(os.tmpdir(),root),/^novel-model-test-[^\\/]+$/);await fs.rm(root,{recursive:true,force:true});}); let release!:()=>void; let reached!:()=>void; const started=new Promise<void>(r=>reached=r);
  const server=createServer(async(_req,res)=>{reached();await new Promise<void>(r=>release=r);res.end('{"data":[{"id":"old-model"}]}');});await listenLocalHttp(server);t.after(()=>new Promise<void>(r=>server.close(()=>r())));
  const url=`http://127.0.0.1:${(server.address() as any).port}`,connections=new AIConnections(root,{encrypt:s=>Buffer.from(s),decrypt:b=>b.toString()});let saved=await connections.save({name:'固定',baseUrl:url,model:'原模型',adapter:'generic',thinking:'default',timeoutSeconds:30,contextWindow:32768,maxOutputTokens:4096,tokenParameter:'max_tokens'},'');const service=new ModelDiscoveryService(connections);const pending=service.discover({connectionId:saved.connections[0].id,baseUrl:url,expectedHash:saved.hash});await started;
  await connections.save({...saved.connections[0],model:'新模型'},saved.hash);release();await assert.rejects(pending,/旧列表已丢弃/);assert.equal((await connections.read()).connections[0].model,'新模型');
});
