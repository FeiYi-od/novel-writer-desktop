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
import { DetectionService, zhuqueDetect } from '../src/main/detection';
import { DetectionUsageStore, detectionUsageMonth } from '../src/main/detection-usage';

const identity = (connectionId = '11111111-1111-4111-8111-111111111111', credentialFingerprint = 'a'.repeat(64)) => ({ connectionId, credentialFingerprint });
const request = (requestId = '22222222-2222-4222-8222-222222222222', at = '2026-10-17T02:00:00.000Z', projectId?: string) => ({ requestId, at, ...(projectId ? { projectId } : {}) });
async function directory(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-usage-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

test('用量账本：Makers 与模型用量分开累计，未知不写零，24h与北京时间月统计', async t => {
  const root = await directory(t);
  const now = new Date('2026-10-17T10:00:00.000Z');
  const store = new DetectionUsageStore(root, () => now);
  const id = identity();
  const first = request('33333333-3333-4333-8333-333333333333');
  await store.begin(id, first);
  await store.record(id, { ...first, status: 'success', makersTokens: 30, modelTokens: 50 });
  // A finalized attempt cannot be rewritten with different numbers.
  await assert.rejects(store.record(id, { ...first, status: 'success', makersTokens: 31, modelTokens: 50 }), /不能重复改写/u);
  const unknown = request('44444444-4444-4444-8444-444444444444');
  await store.begin(id, unknown);
  await store.record(id, { ...unknown, status: 'unknown' });
  const old = request('55555555-5555-4555-8555-555555555555', '2026-09-30T15:00:00.000Z');
  await store.begin(id, old); await store.record(id, { ...old, status: 'success', makersTokens: 7 });
  // Beijing midnight: 16:00Z on 30 September already belongs to the October billing month.
  const boundary = request('56565656-5656-4656-8656-565656565656', '2026-09-30T16:00:00.000Z');
  await store.begin(id, boundary); await store.record(id, { ...boundary, status: 'success', makersTokens: 5 });
  const snapshot = await store.read(id);
  assert.equal(snapshot.requests24h, 2); // the September requests are outside 24h
  assert.equal(snapshot.makersTokens24h, 30);
  assert.equal(snapshot.modelTokens24h, 50);
  assert.equal(snapshot.unknownUsage24h, 1);
  assert.equal(snapshot.localTokens, 35); // 30 in the 24h window plus the 5 that crossed Beijing midnight
  assert.equal(snapshot.unknownUsageMonth, 1);
  assert.equal(snapshot.monthlyLimit, 500000);
  assert.equal(snapshot.estimatedUsed, 35);
  assert.equal(snapshot.remainingEstimate, 500000 - 35);
  assert.equal(snapshot.usageLevel, 'normal');
  assert.equal(detectionUsageMonth(new Date('2026-10-31T16:00:00.000Z')), '2026-11');
});

test('用量账本：合法零扣减保留，缺字段才是未知', async t => {
  const root = await directory(t);
  const store = new DetectionUsageStore(root, () => new Date('2026-10-17T10:00:00.000Z'));
  const id = identity();
  const zero = request('66666666-6666-4666-8666-666666666666');
  await store.begin(id, zero); await store.record(id, { ...zero, status: 'success', makersTokens: 0, modelTokens: 12 });
  const missing = request('77777777-7777-4777-8777-777777777777');
  await store.begin(id, missing); await store.record(id, { ...missing, status: 'success', modelTokens: 12 });
  const snapshot = await store.read(id);
  assert.equal(snapshot.makersTokens24h, 0);
  assert.equal(snapshot.unknownUsage24h, 1);
  assert.equal(snapshot.unknownUsageMonth, 1);
});

test('用量账本：校准按账户已用加本机增量，只改额度不动既有基准，清除后回到本机统计', async t => {
  const root = await directory(t);
  const store = new DetectionUsageStore(root, () => new Date('2026-10-17T10:00:00.000Z'));
  const id = identity();
  const first = request('88888888-8888-4888-8888-888888888888');
  await store.begin(id, first); await store.record(id, { ...first, status: 'success', makersTokens: 100 });
  const before = await store.read(id);
  const calibrated = await store.configure(id, { monthlyLimit: 500000, accountUsed: 4000, expectedHash: before.hash, month: before.month });
  assert.equal(calibrated.estimatedUsed, 4000 + 100 - 100);
  assert.equal(calibrated.baselineLocalTokens, 100);
  const second = request('99999999-9999-4999-8999-999999999999');
  await store.begin(id, second); await store.record(id, { ...second, status: 'success', makersTokens: 25 });
  const grown = await store.read(id);
  assert.equal(grown.estimatedUsed, 4025);
  // Changing only the limit must keep the calibration baseline instead of resetting it.
  const limitOnly = await store.configure(id, { monthlyLimit: 600000, expectedHash: grown.hash, month: grown.month });
  assert.equal(limitOnly.monthlyLimit, 600000);
  assert.equal(limitOnly.accountUsed, 4000);
  assert.equal(limitOnly.estimatedUsed, 4025);
  const cleared = await store.configure(id, { monthlyLimit: 600000, accountUsed: null, expectedHash: limitOnly.hash, month: limitOnly.month });
  assert.equal(cleared.accountUsed, null);
  assert.equal(cleared.estimatedUsed, 125);
  await assert.rejects(store.configure(id, { monthlyLimit: 1, expectedHash: 'f'.repeat(64), month: cleared.month }), /已变化/u);
  await assert.rejects(store.configure(id, { monthlyLimit: 1, expectedHash: cleared.hash, month: '2026-09' }), /月份已变化/u);
});

test('用量账本：跨凭据隔离、损坏与未知版本保留拒绝、容量上限与重复请求号', async t => {
  const root = await directory(t);
  const store = new DetectionUsageStore(root, () => new Date('2026-10-17T10:00:00.000Z'));
  const one = identity(); const two = identity(identity().connectionId, 'b'.repeat(64));
  const attempt = request('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  await store.begin(one, attempt); await store.record(one, { ...attempt, status: 'success', makersTokens: 10 });
  assert.equal((await store.read(two)).makersTokens24h, 0);
  await assert.rejects(store.begin(one, { ...attempt, at: '2026-10-17T03:00:00.000Z' }), /已被其他请求占用/u);
  const file = path.join(root, 'detection-usage', one.connectionId, `${one.credentialFingerprint}.json`);
  const raw = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, raw.replace('"schemaVersion":1', '"schemaVersion":2'));
  await assert.rejects(store.read(one), /损坏或版本不受支持/u);
  assert.equal(await fs.readFile(file, 'utf8'), raw.replace('"schemaVersion":1', '"schemaVersion":2'));
  await fs.writeFile(file, '{not json');
  await assert.rejects(store.read(one), /损坏或版本不受支持/u);
  assert.equal(await fs.readFile(file, 'utf8'), '{not json');
  const restored = JSON.parse(raw) as { events: unknown[] };
  restored.events = Array.from({ length: 20000 }, (_, index) => ({
    requestId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, at: '2026-10-17T00:00:00.000Z',
    status: 'success', makersTokens: 0, finalized: true
  }));
  await fs.writeFile(file, JSON.stringify({ ...JSON.parse(raw), events: restored.events }));
  await assert.rejects(store.begin(one, request('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')), /容量上限/u);
});

test('用量账本：未发出请求可撤回，已完成请求不可撤回', async t => {
  const root = await directory(t);
  const store = new DetectionUsageStore(root, () => new Date('2026-10-17T10:00:00.000Z'));
  const id = identity();
  const pending = request('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  await store.begin(id, pending);
  assert.equal((await store.read(id)).requests24h, 1);
  const cancelled = await store.cancelPending(id, pending.requestId);
  assert.equal(cancelled.requests24h, 0);
  const done = request('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  await store.begin(id, done); await store.record(id, { ...done, status: 'success', makersTokens: 5 });
  await assert.rejects(store.cancelPending(id, done.requestId), /不能撤回/u);
  assert.equal((await store.read(id)).makersTokens24h, 5);
});

async function mockServer(t: { after: (fn: () => Promise<void>) => void }, reply: (body: { text: string }, res: import('node:http').ServerResponse) => void) {
  const calls: { text: string; is_merge: unknown }[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw) as { text: string; is_merge: unknown }; calls.push({ text: body.text, is_merge: body.is_merge }); reply(body, res);
  });
  await listenLocalHttp(server);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, calls };
}

test('检测服务：章节检测先用未知请求占位再落实际扣减，报告保留两种用量', async t => {
  const root = await directory(t);
  const server = await mockServer(t, (_body, res) => { res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'success', labels_ratio: { '0': 0.6, '1': 0.25, '2': 0.15 }, softmax_confidence: 0.9,
      usage: { total_tokens: 50 }, makers_models_usage: { total_tokens: 30 }, segment_labels: [] })); });
  const workspace = new Workspace(path.join(root, 'local')); await workspace.initialize();
  await fs.mkdir(path.join(root, 'A')); const book = await workspace.attach(path.join(root, 'A'));
  const connections = new AIConnections(path.join(root, 'config'), { encrypt: value => Buffer.from(value), decrypt: bytes => bytes.toString() });
  const config = await connections.save({ name: '朱雀', baseUrl: server.url, model: 'zhuque-text', adapter: 'generic', thinking: 'default', contextWindow: 32768, maxOutputTokens: 4096, tokenParameter: 'max_tokens', timeoutSeconds: 60, apiKey: 'fictional-zhuque-key' }, '');
  const service = new DetectionService(path.join(root, 'local'), connections, workspace);
  const doc = await workspace.createChapter(book.id, textDocument('虚构检测正文。'));
  const report = await service.detect(book.id, doc.path, doc.hash, config.connections[0].id);
  assert.equal(report.makersTokens, 30); assert.equal(report.modelTokens, 50); assert.equal(report.usageWarning, undefined);
  const usage = await service.usage(config.connections[0].id);
  assert.equal(usage.makersTokens24h, 30); assert.equal(usage.modelTokens24h, 50); assert.equal(usage.requests24h, 1);
  assert.equal(usage.localTokens, 30);
  // Stored attempts stay bound to the novel, and reading the report back keeps the usage fields.
  assert.equal((await service.list(book.id))[0].usageWarning, undefined);
  assert.equal(server.calls[0].is_merge, false);
});

test('检测服务：缺用量记未知、失败也保留实际扣减、报告可读回', async t => {
  const root = await directory(t);
  const server = await mockServer(t, (body, res) => {
    if (body.text.includes('失败')) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ makers_models_usage: { total_tokens: 12 } })); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'success', labels_ratio: { '0': 0.5, '1': 0.3, '2': 0.2 }, segment_labels: [] }));
  });
  const workspace = new Workspace(path.join(root, 'local')); await workspace.initialize();
  await fs.mkdir(path.join(root, 'A')); const book = await workspace.attach(path.join(root, 'A'));
  const connections = new AIConnections(path.join(root, 'config'), { encrypt: value => Buffer.from(value), decrypt: bytes => bytes.toString() });
  const config = await connections.save({ name: '朱雀', baseUrl: server.url, model: 'zhuque-text', adapter: 'generic', thinking: 'default', contextWindow: 32768, maxOutputTokens: 4096, tokenParameter: 'max_tokens', timeoutSeconds: 60, apiKey: 'fictional-zhuque-key' }, '');
  const service = new DetectionService(path.join(root, 'local'), connections, workspace);
  const doc = await workspace.createChapter(book.id, textDocument('虚构检测正文，服务未返回扣减。'));
  const report = await service.detect(book.id, doc.path, doc.hash, config.connections[0].id);
  assert.match(String(report.usageWarning), /未知/u);
  const failed = await workspace.createChapter(book.id, textDocument('虚构检测正文，本次失败。'));
  await assert.rejects(service.detect(book.id, failed.path, failed.hash, config.connections[0].id), error => {
    assert.match(String(error), /500/u); assert.match(String(error), /12 Token/u); return true; });
  const usage = await service.usage(config.connections[0].id);
  assert.equal(usage.requests24h, 2);
  assert.equal(usage.errors24h, 1);
  assert.equal(usage.makersTokens24h, 12);
  assert.equal(usage.unknownUsage24h, 1); // only the successful request lacked deduction data
  assert.equal((await service.list(book.id)).length, 1);
});

test('检测服务：连接测试只发固定虚构短文、不写小说报告，并记录本月未知/实际扣减', async t => {
  const root = await directory(t);
  const server = await mockServer(t, (_body, res) => { res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'success', labels_ratio: { '0': 0.7, '1': 0.2, '2': 0.1 }, softmax_confidence: 0.8, makers_models_usage: { total_tokens: 5 }, segment_labels: [] })); });
  const workspace = new Workspace(path.join(root, 'local')); await workspace.initialize();
  await fs.mkdir(path.join(root, 'A')); const book = await workspace.attach(path.join(root, 'A'));
  const connections = new AIConnections(path.join(root, 'config'), { encrypt: value => Buffer.from(value), decrypt: bytes => bytes.toString() });
  const config = await connections.save({ name: '朱雀', baseUrl: server.url, model: 'zhuque-text', adapter: 'generic', thinking: 'default', contextWindow: 32768, maxOutputTokens: 4096, tokenParameter: 'max_tokens', timeoutSeconds: 60, apiKey: 'fictional-zhuque-key' }, '');
  const service = new DetectionService(path.join(root, 'local'), connections, workspace);
  const result = await service.testConnection(config.connections[0].id);
  assert.equal(result.makersTokens, 5); assert.equal(result.usage.makersTokens24h, 5);
  assert.equal(server.calls.length, 1);
  assert.match(server.calls[0].text, /固定虚构短文/u);
  assert.equal((await service.list(book.id)).length, 0);
  // A changed key must not inherit the previous credential's ledger.
  const edited = await connections.save({ id: config.connections[0].id, name: '朱雀', baseUrl: server.url, model: 'zhuque-text', adapter: 'generic', thinking: 'default', contextWindow: 32768, maxOutputTokens: 4096, tokenParameter: 'max_tokens', timeoutSeconds: 60, apiKey: 'another-fictional-key' }, config.hash);
  const rotated = await service.usage(edited.connections[0].id);
  assert.equal(rotated.makersTokens24h, 0);
  assert.notEqual(rotated.credentialFingerprint, result.usage.credentialFingerprint);
  // Calibration from a stale fingerprint or old hash is refused.
  await assert.rejects(service.configureUsage({ connectionId: edited.connections[0].id, credentialFingerprint: result.usage.credentialFingerprint, expectedHash: rotated.hash, month: rotated.month, monthlyLimit: 500000, accountUsed: 1 }), /已变化/u);
  await assert.rejects(service.configureUsage({ connectionId: edited.connections[0].id, credentialFingerprint: rotated.credentialFingerprint, expectedHash: 'e'.repeat(64), month: rotated.month, monthlyLimit: 500000, accountUsed: 1 }), /已变化/u);
  const calibrated = await service.configureUsage({ connectionId: edited.connections[0].id, credentialFingerprint: rotated.credentialFingerprint, expectedHash: rotated.hash, month: rotated.month, monthlyLimit: 500000, accountUsed: 900 });
  assert.equal(calibrated.estimatedUsed, 900);
});

test('检测服务：无密钥不发HTTP、正文变化前先撤回占位请求', async t => {
  const root = await directory(t);
  const server = await mockServer(t, (_body, res) => { res.end('{}'); });
  const workspace = new Workspace(path.join(root, 'local')); await workspace.initialize();
  await fs.mkdir(path.join(root, 'A')); const book = await workspace.attach(path.join(root, 'A'));
  const connections = new AIConnections(path.join(root, 'config'), { encrypt: value => Buffer.from(value), decrypt: bytes => bytes.toString() });
  const withKey = await connections.save({ name: '朱雀', baseUrl: server.url, model: 'zhuque-text', adapter: 'generic', thinking: 'default', contextWindow: 32768, maxOutputTokens: 4096, tokenParameter: 'max_tokens', timeoutSeconds: 60, apiKey: 'fictional-zhuque-key' }, '');
  const service = new DetectionService(path.join(root, 'local'), connections, workspace);
  const doc = await workspace.createChapter(book.id, textDocument('虚构检测正文。'));
  const empty = await connections.save({ name: '空密钥', baseUrl: server.url, model: 'zhuque-text', adapter: 'generic', thinking: 'default', contextWindow: 32768, maxOutputTokens: 4096, tokenParameter: 'max_tokens', timeoutSeconds: 60, apiKey: '' }, withKey.hash);
  await assert.rejects(service.detect(book.id, doc.path, doc.hash, empty.connections[1].id), /Makers API Key/u);
  assert.equal(server.calls.length, 0);
  assert.equal((await service.usage(withKey.connections[0].id)).requests24h, 0);
  // A stale source hash never reaches HTTP either.
  await assert.rejects(service.detect(book.id, doc.path, 'f'.repeat(64), withKey.connections[0].id), /正文已变化/u);
  assert.equal(server.calls.length, 0);
  // Signature-level checks stay in force for the raw client too.
  await assert.rejects(zhuqueDetect(server.url, 'fictional-key', ' ', AbortSignal.timeout(500)), /有内容/u);
});
