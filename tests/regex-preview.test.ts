import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { RegexPreviewRunner, REGEX_PREVIEW_LIMITS, type RegexPreviewTask, freezeRegexPreviewTask } from '../src/main/regex-preview';
import { applyRegexScripts, substituteMacros } from '../src/core/st-macros';
import { regexWorkerFactory } from './regex-worker-fixture';

const task = (edit: Partial<RegexPreviewTask> = {}): RegexPreviewTask => ({ projectId: randomUUID(), requestId: randomUUID(), text: '虚构输入', scripts: [], env: {}, ...edit });
const hostile = () => task({ text: 'a'.repeat(10000) + '!', scripts: [{ findRegex: '/^(a+)+(?=b)$/', replaceString: '' }] });

test('隔离正则：真实worker保留宏、捕获、trim、顺序与非法脚本语义', async () => {
  const runner = new RegexPreviewRunner(await regexWorkerFactory());
  const input = task({ text: '[~~{{char}}~~] ~~外~~ CAT cat', env: { char: '林岚', user: '作者', seed: 'fixture' }, scripts: [
    { findRegex: '/\\[(.*?)\\]/g', replaceString: '{{match}}|$0|$1|$<missing>', trimStrings: ['~'] },
    { findRegex: '/cat/gi', replaceString: '猫' }, { findRegex: '/外/g', replaceString: '错误', disabled: true },
    { findRegex: '/cat/gg', replaceString: '错误' }
  ] });
  const output = await runner.run(input);
  assert.equal(output.projectId, input.projectId); assert.equal(output.requestId, input.requestId);
  assert.equal(output.expanded, '[~~林岚~~] ~~外~~ CAT cat');
  assert.equal(output.applied, '[林岚]|[林岚]|林岚| ~~外~~ 猫 猫');
  assert.equal(runner.activeCount, 0);
});

test('隔离正则：请求、脚本与宏上下文在调用时冻结', async () => {
  const runner = new RegexPreviewRunner(await regexWorkerFactory());
  const input = task({ text: '{{char}}甲', env: { char: '林岚' }, scripts: [{ findRegex: '/甲/g', replaceString: '一', trimStrings: ['~'] }] });
  const frozenId = input.projectId, frozenRequest = input.requestId;
  const pending = runner.run(input);
  input.projectId = randomUUID(); input.requestId = randomUUID(); input.text = '不能迟改'; input.env.char = '另一本';
  input.scripts[0].replaceString = '二'; input.scripts[0].trimStrings!.push('林岚');
  const result = await pending;
  assert.equal(result.projectId, frozenId); assert.equal(result.requestId, frozenRequest); assert.equal(result.applied, '林岚一');
});

test('隔离正则：恶意回溯超时终止，主线程持续响应且容量释放', async () => {
  const runner = new RegexPreviewRunner(await regexWorkerFactory(), { timeoutMs: 400, maxConcurrent: 1 });
  let ticks = 0; const timer = setInterval(() => ticks++, 5);
  try { await assert.rejects(runner.run(hostile()), /超过时限/); }
  finally { clearInterval(timer); }
  assert.ok(ticks > 2, '主线程应可处理计时器，而不是直接执行恶意正则');
  assert.equal(runner.activeCount, 0);
  assert.equal((await runner.run(task({ text: '可继续' }))).applied, '可继续');
});

test('隔离正则：取消真正结束worker后才能启动下一次，预取消不创建worker', async () => {
  const actualFactory = await regexWorkerFactory(); let starts = 0;
  const runner = new RegexPreviewRunner(options => { starts++; return actualFactory(options); });
  const before = new AbortController(); before.abort();
  await assert.rejects(runner.run(hostile(), before.signal), /取消/); assert.equal(starts, 0);
  const controller = new AbortController(), pending = runner.run(hostile(), controller.signal);
  assert.equal(runner.activeCount, 1); setTimeout(() => controller.abort(), 80);
  await assert.rejects(pending, /取消/); assert.equal(runner.activeCount, 0);
  assert.equal((await runner.run(task({ text: '取消后可继续' }))).applied, '取消后可继续'); assert.equal(starts, 2);
});

test('隔离正则：全局容量与重复请求拒绝，错书请求不共享身份', async () => {
  const runner = new RegexPreviewRunner(await regexWorkerFactory());
  const first = hostile(), second = hostile(), a = new AbortController(), b = new AbortController();
  const one = runner.run(first, a.signal), two = runner.run(second, b.signal);
  const oneRejected = assert.rejects(one, /取消/), twoRejected = assert.rejects(two, /取消/);
  assert.equal(runner.activeCount, 2);
  await assert.rejects(runner.run(first), /已经在处理/);
  await assert.rejects(runner.run(task()), /线程已满/);
  a.abort(); b.abort(); await Promise.all([oneRejected, twoRejected]); assert.equal(runner.activeCount, 0);
  const sameRequest = randomUUID();
  const outputs = await Promise.all([runner.run(task({ requestId: sameRequest, text: '甲' })), runner.run(task({ requestId: sameRequest, text: '乙' }))]);
  assert.notEqual(outputs[0].projectId, outputs[1].projectId); assert.equal(outputs[0].applied, '甲'); assert.equal(outputs[1].applied, '乙');
});

test('隔离正则：收到成功消息后等待线程终止期间取消，仍不返回成功', async () => {
  const realFactory = await regexWorkerFactory(), controller = new AbortController();
  const runner = new RegexPreviewRunner(options => {
    const worker = realFactory(options), terminate = worker.terminate.bind(worker);
    worker.terminate = async () => { await new Promise(resolve => setTimeout(resolve, 80)); return terminate(); };
    worker.once('message', () => { setTimeout(() => controller.abort(), 10); });
    return worker;
  });
  await assert.rejects(runner.run(task(), controller.signal), /取消/); assert.equal(runner.activeCount, 0);
});

test('隔离正则：终止失败不提前释放仍存活worker的容量', async () => {
  let exited!: Promise<void>;
  const runner = new RegexPreviewRunner(options => {
    const worker = new Worker("const {parentPort,workerData}=require('node:worker_threads');parentPort.postMessage({ok:true,projectId:workerData.projectId,requestId:workerData.requestId,expanded:'x',applied:'x'});setInterval(()=>{},1000);", { ...options, eval: true });
    const terminate = worker.terminate.bind(worker);
    exited = new Promise(resolve => worker.once('exit', () => resolve()));
    worker.terminate = async () => { setTimeout(() => void terminate(), 80); throw new Error('fixed fixture failure'); };
    return worker;
  }, { maxConcurrent: 1 });
  await assert.rejects(runner.run(task()), /终止失败/); assert.equal(runner.activeCount, 1);
  await assert.rejects(runner.run(task()), /线程已满/);
  await exited; assert.equal(runner.activeCount, 0);
});

test('隔离正则：宏、零宽、捕获模板与多轮膨胀超限不返回部分结果', async t => {
  const runner = new RegexPreviewRunner(await regexWorkerFactory());
  const cases = [
    task({ text: '{{char}}'.repeat(20), env: { char: '文'.repeat(20000) } }),
    task({ text: '文'.repeat(20000), scripts: [{ findRegex: '/(?:)/g', replaceString: '放'.repeat(32768) }] }),
    task({ text: '文'.repeat(20000), scripts: [{ findRegex: '/(.*)/', replaceString: '$1'.repeat(100) }] }),
    task({ text: '文'.repeat(20000), scripts: [{ findRegex: '/文/g', replaceString: '文文文' }, { findRegex: '/文/g', replaceString: '文文文文' }] })
  ];
  for (const [index, input] of cases.entries()) await t.test(String(index), async () => {
    await assert.rejects(runner.run(input), /输出上限/); assert.equal(runner.activeCount, 0);
  });
  assert.equal((await runner.run(task({ text: '原稿不改' }))).applied, '原稿不改');
});

test('隔离正则：参数边界、未知字段及序列化大小在启动线程前拒绝', async t => {
  let starts = 0; const realFactory = await regexWorkerFactory();
  const runner = new RegexPreviewRunner(options => { starts++; return realFactory(options); });
  const cases: unknown[] = [
    task({ projectId: 'bad' }), task({ requestId: 'bad' }), task({ text: 'a'.repeat(20001) }),
    task({ scripts: Array.from({ length: 257 }, () => ({ findRegex: 'a', replaceString: '' })) }),
    task({ scripts: [{ findRegex: 'a'.repeat(8193), replaceString: '' }] }),
    task({ scripts: [{ findRegex: 'a', replaceString: 'x'.repeat(32769) }] }),
    task({ scripts: [{ findRegex: 'a', replaceString: '', trimStrings: Array(129).fill('x') }] }),
    task({ scripts: [{ findRegex: 'a', replaceString: '', trimStrings: ['x'.repeat(8193)] }] }),
    task({ scripts: [{ findRegex: 'a', replaceString: '', flags: 'x'.repeat(8193) }] }),
    task({ env: { char: 'x'.repeat(20001) } }), { ...task(), extra: true },
    task({ scripts: [{ findRegex: 'a', replaceString: '', run: 'arbitrary plugin JS' } as never] }),
    task({ scripts: Array.from({ length: 40 }, () => ({ findRegex: 'a', replaceString: '\u0000'.repeat(8192) })) })
  ];
  for (const [index, input] of cases.entries()) await t.test(String(index), () => assert.rejects(runner.run(input as RegexPreviewTask), /上限|标识|256|128|未知|MiB/));
  assert.equal(starts, 0); assert.equal(runner.activeCount, 0);
  const accessors = task(); Object.defineProperty(accessors, 'text', { get() { throw new Error('不应访问getter'); }, enumerable: true });
  await assert.rejects(runner.run(accessors), /动态属性/);
});

test('隔离正则：恰好输出上限可用，不放大时默认core兼容不受限制', async () => {
  const runner = new RegexPreviewRunner(await regexWorkerFactory());
  const result = await runner.run(task({ text: '文'.repeat(20000), scripts: [{ findRegex: '/文/g', replaceString: '字'.repeat(10) }] }));
  assert.equal(result.applied.length, REGEX_PREVIEW_LIMITS.outputCharacters);
  assert.equal(substituteMacros('{{char}}', { char: '长'.repeat(200001) }).length, 200001);
  assert.equal(applyRegexScripts('a', [{ findRegex: 'a', replaceString: '长'.repeat(200001) }]).length, 200001);
  assert.throws(() => substituteMacros('{{char}}', { char: '长'.repeat(201) }, Math.random, 200), /输出上限/);
  assert.throws(() => applyRegexScripts('a', [{ findRegex: 'a', replaceString: '长'.repeat(201) }], {}, 200), /输出上限/);
});

test('隔离正则：worker启动失败、错误/提前退出与伪造结果都拒绝并释放容量', async t => {
  const failStart = new RegexPreviewRunner(() => { throw new Error('fixture'); });
  await assert.rejects(failStart.run(task()), /启动失败/); assert.equal(failStart.activeCount, 0);
  const cases = [
    { source: "throw new Error('fixture')", expected: /执行失败/ },
    { source: 'process.exit(0)', expected: /提前结束/ },
    { source: "const {parentPort,workerData}=require('node:worker_threads');parentPort.postMessage({ok:true,projectId:'another',requestId:workerData.requestId,expanded:'partial',applied:'partial'});", expected: /归属/ },
    { source: "const {parentPort,workerData}=require('node:worker_threads');parentPort.postMessage({ok:true,projectId:workerData.projectId,requestId:workerData.requestId,expanded:'x',applied:'x'.repeat(200001)});", expected: /输出上限/ },
    { source: "const {parentPort,workerData}=require('node:worker_threads');parentPort.postMessage({ok:false,projectId:workerData.projectId,requestId:workerData.requestId,error:'fixture failure'});", expected: /fixture failure/ }
  ];
  for (const [index, fixture] of cases.entries()) await t.test(String(index), async () => {
    // These are fixed local fixtures, never community/plugin source or user input.
    const runner = new RegexPreviewRunner(options => new Worker(fixture.source, { ...options, eval: true }));
    await assert.rejects(runner.run(task()), fixture.expected); assert.equal(runner.activeCount, 0);
  });
});

test('隔离正则：冻结器拒绝无效配置且不依赖UI限长', () => {
  assert.throws(() => new RegexPreviewRunner(() => { throw new Error(); }, { timeoutMs: 0 }), /配置无效/);
  assert.throws(() => new RegexPreviewRunner(() => { throw new Error(); }, { maxConcurrent: 0 }), /配置无效/);
  assert.equal(freezeRegexPreviewTask(task({ text: '字'.repeat(20000) })).text.length, 20000);
});
