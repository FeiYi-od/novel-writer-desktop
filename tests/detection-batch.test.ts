import { listenLocalHttp } from './support/local-http';
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
import { DetectionService } from '../src/main/detection';

async function directory(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-batch-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return root;
}
async function mockServer(t: { after: (fn: () => Promise<void>) => void }, reply: (text: string, res: import('node:http').ServerResponse) => void | Promise<void>) {
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw) as { text: string }; calls.push(body.text);
    res.setHeader('Content-Type', 'application/json');
    await reply(body.text, res);
  });
  await listenLocalHttp(server);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, calls };
}
const ok = (makers = 10) => (text: string, res: import('node:http').ServerResponse) => {
  if (text.includes('慢')) return new Promise<void>(resolve => setTimeout(() => { res.end(JSON.stringify({ status: 'success', labels_ratio: { '0': 0.6, '1': 0.3, '2': 0.1 }, makers_models_usage: { total_tokens: makers }, segment_labels: [] })); resolve(); }, 500));
  res.end(JSON.stringify({ status: 'success', labels_ratio: { '0': 0.6, '1': 0.3, '2': 0.1 }, makers_models_usage: { total_tokens: makers }, segment_labels: [] }));
  return undefined;
};
async function setup(t: { after: (fn: () => Promise<void>) => void }, reply: (text: string, res: import('node:http').ServerResponse) => void | Promise<void>) {
  const root = await directory(t); const server = await mockServer(t, reply);
  const workspace = new Workspace(path.join(root, 'local')); await workspace.initialize();
  await fs.mkdir(path.join(root, 'A')); await fs.mkdir(path.join(root, 'B'));
  const a = await workspace.attach(path.join(root, 'A')); const b = await workspace.attach(path.join(root, 'B'));
  const connections = new AIConnections(path.join(root, 'config'), { encrypt: value => Buffer.from(value), decrypt: bytes => bytes.toString() });
  const config = await connections.save({ name: '朱雀', baseUrl: server.url, model: 'zhuque-text', adapter: 'generic', thinking: 'default', contextWindow: 32768, maxOutputTokens: 4096, tokenParameter: 'max_tokens', timeoutSeconds: 60, apiKey: 'fictional-batch-key' }, '');
  const service = new DetectionService(path.join(root, 'local'), connections, workspace);
  const chapter = (text: string) => workspace.createChapter(a.id, textDocument(text));
  return { root, server, workspace, a, b, service, connectionId: config.connections[0].id, chapter };
}
const waitFor = async (check: () => boolean, timeout = 3000) => {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error('等待超时'); await new Promise(resolve => setTimeout(resolve, 10)); }
};

test('批量检测：顺序逐章出报告，每章各计一次，状态可查询', async t => {
  const { server, service, a, connectionId, chapter } = await setup(t, ok());
  const one = await chapter('第一章虚构正文。'), two = await chapter('第二章虚构正文。'), three = await chapter('第三章虚构正文。');
  const state = await service.batch(a.id, { connectionId, items: [{ path: one.path }, { path: two.path, hash: two.hash }, { path: three.path }] });
  assert.deepEqual({ running: state.running, stopped: state.stopped, total: state.total, completed: state.completed, created: state.created }, { running: false, stopped: false, total: 3, completed: 3, created: 3 });
  assert.deepEqual(state.failures, []);
  assert.ok(state.startedAt && state.finishedAt);
  assert.equal(server.calls.length, 3);
  const reports = await service.list(a.id);
  assert.equal(reports.length, 3);
  assert.deepEqual(new Set(reports.map(report => report.sourceHash)), new Set([one.hash, two.hash, three.hash]));
  const usage = await service.usage(connectionId);
  assert.equal(usage.requests24h, 3); assert.equal(usage.makersTokens24h, 30);
  const snapshot = service.batchState(a.id)!;
  assert.equal(snapshot.running, false); assert.equal(snapshot.created, 3); assert.equal(snapshot.current, '');
});

test('批量检测：单章失败只记录该项并继续其余章节，不重试', async t => {
  const { server, service, a, connectionId, chapter } = await setup(t, (text, res) => {
    if (text.includes('坏')) { res.writeHead(500); res.end(JSON.stringify({ makers_models_usage: { total_tokens: 7 } })); return undefined; }
    return ok()(text, res);
  });
  const good = await chapter('第一章虚构正文。'), bad = await chapter('这一章故意坏掉。'), after = await chapter('第三章虚构正文。');
  const state = await service.batch(a.id, { connectionId, items: [{ path: good.path }, { path: bad.path }, { path: after.path }] });
  assert.equal(state.created, 2); assert.equal(state.failures.length, 1);
  assert.equal(state.failures[0].path, bad.path); assert.match(state.failures[0].message, /500/u);
  assert.equal(server.calls.length, 3); // the failing chapter is never retried
  assert.equal((await service.list(a.id)).length, 2);
  const usage = await service.usage(connectionId);
  assert.equal(usage.requests24h, 3); assert.equal(usage.errors24h, 1); assert.equal(usage.makersTokens24h, 27);
  // A finished batch can be listed and a new one may start afterwards.
  assert.equal(service.batchState(a.id)!.failures.length, 1);
  const again = await service.batch(a.id, { connectionId, items: [{ path: good.path }] });
  assert.equal(again.created, 1);
});

test('批量检测：中途停止不开始后续章节，当前请求作废但已生成报告保留', async t => {
  const { server, service, a, connectionId, chapter } = await setup(t, ok());
  const first = await chapter('第一章虚构正文。'), slow = await chapter('这一章很慢，会被停止。'), rest = await chapter('第三章不应被发送。');
  const running = service.batch(a.id, { connectionId, items: [{ path: first.path }, { path: slow.path }, { path: rest.path }] });
  await waitFor(() => server.calls.length >= 2);
  service.cancelBatch(a.id);
  const state = await running;
  assert.equal(state.stopped, true); assert.equal(state.running, false);
  assert.equal(state.created, 1); assert.equal(state.completed, 2);
  assert.equal(state.failures.length, 1); assert.equal(state.failures[0].path, slow.path);
  assert.equal(server.calls.length, 2); // the third chapter was never sent
  assert.equal((await service.list(a.id)).length, 1);
  // The lock is released, so the author can start over.
  const retry = await service.batch(a.id, { connectionId, items: [{ path: rest.path }] });
  assert.equal(retry.created, 1);
});

test('批量检测：启动前拒绝空/重复/超限/跨书/版本不符，且不发任何 HTTP', async t => {
  const { server, workspace, service, a, b, connectionId, chapter } = await setup(t, ok());
  const one = await chapter('第一章虚构正文。');
  const other = await workspace.createChapter(b.id, textDocument('别的书的正文。'));
  await assert.rejects(service.batch(a.id, { connectionId, items: [] }), /至少一个章节/u);
  await assert.rejects(service.batch(a.id, { connectionId, items: [{ path: one.path }, { path: one.path }] }), /不能重复/u);
  await assert.rejects(service.batch(a.id, { connectionId, items: Array.from({ length: 51 }, (_, index) => ({ path: `x${index}.txt` })) }), /最多批量检测 50/u);
  await assert.rejects(service.batch(a.id, { connectionId, items: [{ path: other.path }] }));
  await assert.rejects(service.batch(a.id, { connectionId, items: [{ path: one.path, hash: 'f'.repeat(64) }] }), /外部变化/u);
  await assert.rejects(service.batch(a.id, { connectionId: '11111111-1111-4111-8111-111111111111', items: [{ path: one.path }] }), /连接/u);
  assert.equal(server.calls.length, 0);
  assert.equal(service.batchState(a.id), null);
  service.cancelBatch(a.id); // no batch yet: harmless
  assert.equal((await service.usage(connectionId)).requests24h, 0);
});
