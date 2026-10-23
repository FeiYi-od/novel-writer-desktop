import { listenLocalHttp } from './support/local-http';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { zhuqueDetect, type ZhuqueUsage } from '../src/main/detection';

const detection = { status: 'success', labels_ratio: { '0': 0.6, '1': 0.25, '2': 0.15 }, softmax_confidence: 0.91, segment_labels: [] };
async function mock(t: TestContext, reply: (text: string, response: import('node:http').ServerResponse) => void) {
  const calls: { url?: string; key?: string; text: string; is_merge: unknown }[] = [];
  const server = createServer(async (req, res) => { let raw = ''; for await (const part of req) raw += part; const body = JSON.parse(raw);
    calls.push({ url: req.url, key: req.headers.authorization, text: body.text, is_merge: body.is_merge }); reply(body.text, res); });
  await listenLocalHttp(server);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, calls };
}

test('朱雀自身token与Makers实际扣减分开，缺字段未知且合法零用量保留', async t => {
  const f = await mock(t, (text, res) => { res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ...detection, ...(text === 'missing' ? {} : { usage: { total_tokens: 50 }, makers_models_usage: { total_tokens: text === 'zero' ? 0 : 30 } }) })); });
  const standard = await zhuqueDetect(`${f.url}/v1`, 'fictional-key', 'standard', AbortSignal.timeout(1000));
  assert.equal(standard.modelTokens, 50); assert.equal(standard.makersTokens, 30);
  const missing = await zhuqueDetect(f.url, 'fictional-key', 'missing', AbortSignal.timeout(1000));
  assert.equal(missing.modelTokens, undefined); assert.equal(missing.makersTokens, undefined);
  const zero = await zhuqueDetect(`${f.url}/v1/providers/zhuque-text/classify`, 'fictional-key', 'zero', AbortSignal.timeout(1000));
  assert.equal(zero.makersTokens, 0); assert.equal(zero.modelTokens, 50);
  assert.ok(f.calls.every(call => call.url === '/v1/providers/zhuque-text/classify' && call.key === 'Bearer fictional-key' && call.is_merge === false));
});

test('标签报告解析失败仍先提取实际扣减，不能以无报告当零消耗', async t => {
  const f = await mock(t, (_, res) => { res.end(JSON.stringify({ status: 'success', usage: { total_tokens: 700 }, makers_models_usage: { total_tokens: 40 } })); });
  let usage: ZhuqueUsage | undefined;
  await assert.rejects(zhuqueDetect(f.url, 'fictional-key', '虚构正文', AbortSignal.timeout(1000), value => { usage = value; }), /格式/u);
  assert.deepEqual(usage, { modelTokens: 700, makersTokens: 40 }); assert.equal(f.calls.length, 1);
});

test('认证/429/服务器错误安全分类，不泄漏响应或密钥，429不宣称已用完额度', async t => {
  const f = await mock(t, (text, res) => { res.writeHead(Number(text), { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: 'RAW_SECRET_fictional-key', usage: { total_tokens: 999 }, makers_models_usage: { total_tokens: 12 } })); });
  for (const status of [401, 403, 429, 503]) {
    let usage: ZhuqueUsage | undefined;
    await assert.rejects(zhuqueDetect(f.url, 'fictional-key', String(status), AbortSignal.timeout(1000), value => { usage = value; }), error => {
      assert.match(String(error), new RegExp(String(status))); assert.doesNotMatch(String(error), /RAW_SECRET|fictional-key/u);
      if (status === 429) { assert.match(String(error), /可能.*限流.*额度/u); assert.doesNotMatch(String(error), /额度已用完|额度已耗尽/u); }
      else if (status === 401 || status === 403) assert.match(String(error), /认证/u);
      return true;
    });
    assert.equal(usage?.makersTokens, 12);
  }
  assert.equal(f.calls.length, 4);
});

test('非法token不替换为零、不使用modelTokens推算Makers，未知仍可保留有效检测', async t => {
  const f = await mock(t, (text, res) => { res.end(JSON.stringify({ ...detection, usage: { total_tokens: 999 }, makers_models_usage: { total_tokens: text === 'negative' ? -1 : '99' } })); });
  for (const value of ['negative', 'string']) { const result = await zhuqueDetect(f.url, 'fictional-key', value, AbortSignal.timeout(1000)); assert.equal(result.modelTokens, 999); assert.equal(result.makersTokens, undefined); }
});

test('请求空文/超长/带凭据地址在HTTP前拒绝，重定向和超时没有自动重试', async t => {
  const f = await mock(t, (text, res) => { if (text === 'redirect') { res.writeHead(302, { Location: '/second' }); res.end(); } });
  await assert.rejects(zhuqueDetect(f.url, 'fictional-key', ' ', AbortSignal.timeout(1000)), /有内容/u);
  await assert.rejects(zhuqueDetect(f.url, 'fictional-key', 'x'.repeat(100001), AbortSignal.timeout(1000)), /10 万/u);
  await assert.rejects(zhuqueDetect(`${f.url}?key=fictional-key`, 'fictional-key', 'not-sent', AbortSignal.timeout(1000)), /API 地址/u);
  assert.equal(f.calls.length, 0);
  await assert.rejects(zhuqueDetect(f.url, 'fictional-key', 'redirect', AbortSignal.timeout(1000)));
  await assert.rejects(zhuqueDetect(f.url, 'fictional-key', 'hold', AbortSignal.timeout(250)));
  assert.equal(f.calls.length, 2);
});
