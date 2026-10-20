import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AIConnections } from '../src/main/ai-connections';
import { Workspace } from '../src/main/workspace';
import { textDocument } from '../src/main/text-import';
import { DetectionService, zhuqueDetect } from '../src/main/detection';

test('腾讯朱雀：官方请求结构、占比和置信度区分、真实版本绑定与按书保存', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-detect-')); const calls: any[] = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const part of req) text += part;
    const body = JSON.parse(text); calls.push({ url: req.url, key: req.headers.authorization, body });
    if (body.text === 'error') { res.writeHead(403); res.end('SECRET'); return; }
    res.setHeader('Content-Type', 'application/json');
    if (body.text === 'malformed') { res.end('{"status":"success"}'); return; }
    res.end(JSON.stringify({ status: 'success', labels_ratio: { '0': 0.6, '1': 0.25, '2': 0.15 }, softmax_confidence: 0.91, segment_labels: [{ text: body.text, label: 2, conf: 0.7 }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const workspace = new Workspace(path.join(root, 'local')); await workspace.initialize(); await fs.mkdir(path.join(root, 'A')); await fs.mkdir(path.join(root, 'B'));
  const a = await workspace.attach(path.join(root, 'A')), b = await workspace.attach(path.join(root, 'B'));
  const connections = new AIConnections(path.join(root, 'config'), { encrypt: value => Buffer.from(value), decrypt: bytes => bytes.toString() });
  const config = await connections.save({ name: '检测', baseUrl: url, model: 'zhuque-text', apiKey: 'test-detection-key', adapter: 'generic', thinking: 'default', contextWindow: 4096, maxOutputTokens: 500, tokenParameter: 'max_tokens', timeoutSeconds: 60 }, '');
  const service = new DetectionService(path.join(root, 'local'), connections, workspace);
  const doc = await workspace.createChapter(a.id, textDocument('测试检测正文。'));
  const report = await service.detect(a.id, doc.path, doc.hash, config.connections[0].id);
  assert.equal(report.aiRatio, 0.25); assert.equal(report.suspectedRatio, 0.15); assert.equal(report.confidence, 0.91);
  assert.equal(calls[0].url, '/v1/providers/zhuque-text/classify'); assert.equal(calls[0].body.is_merge, false); assert.equal(calls[0].key, 'Bearer test-detection-key');
  assert.equal(calls[0].body.text, '　　测试检测正文。');
  assert.equal((await service.list(a.id))[0].sourceHash, doc.hash); assert.equal((await service.list(b.id)).length, 0);
  assert.equal((await workspace.readChapter(a.id, doc.path)).hash, doc.hash);
  await assert.rejects(service.detect(a.id, doc.path, 'stale', config.connections[0].id), /正文已变化/);
  await assert.rejects(zhuqueDetect(url, 'test', 'error', AbortSignal.timeout(1000)), error => { assert.match(String(error), /403/); assert.doesNotMatch(String(error), /SECRET/); return true; });
  await assert.rejects(zhuqueDetect(url, 'test', 'malformed', AbortSignal.timeout(1000)), /格式/);
  assert.equal((await service.list(a.id)).length, 1);
});
