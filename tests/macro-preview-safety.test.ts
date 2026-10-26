import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workspace } from '../src/main/workspace';
import { MacroStore } from '../src/main/macros';
import { OperationGate } from '../src/main/operation-gate';
import { RegexPreviewRunner } from '../src/main/regex-preview';
import { regexWorkerFactory } from './regex-worker-fixture';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const scripts = [{ findRegex: '/cat/g', replaceString: '猫' }];

async function fixture(gate?: OperationGate) {
  const root = await fs.mkdtemp(path.resolve('.artifacts/macro-preview-safety-042-'));
  const workspace = new Workspace(path.join(root, 'profile'), path.join(root, 'materials'));
  await workspace.initialize();
  const book = path.join(root, 'A/虚构同名书'), otherBook = path.join(root, 'B/虚构同名书');
  await fs.mkdir(book, { recursive: true }); await fs.mkdir(otherBook, { recursive: true });
  const project = await workspace.attach(book), other = await workspace.attach(otherBook);
  await workspace.readNotes(project.id); await workspace.readNotes(other.id);
  let workerStarts = 0;
  const factory = await regexWorkerFactory();
  const runner = new RegexPreviewRunner(options => { workerStarts++; return factory(options); });
  const store = new MacroStore(workspace, runner, gate ? action => gate.shared(action) : undefined);
  const file = path.join(book, '小说资料/正则脚本.json');
  return { root, workspace, project, other, runner, store, file, workerStarts: () => workerStarts };
}

async function pendingWorkerResult(f: Awaited<ReturnType<typeof fixture>>) {
  const ready = deferred(), release = deferred(), run = f.runner.run.bind(f.runner);
  f.runner.run = async (input, signal) => {
    const output = await run(input, signal);
    ready.resolve(); await release.promise;
    return output;
  };
  return { ready: ready.promise, release: release.resolve };
}

test('正则预览：排队前登记会话，取消后即使获锁也不启动worker', async () => {
  const gate = new OperationGate(), hold = deferred();
  const blocker = gate.exclusive(() => hold.promise);
  const f = await fixture(gate), requestId = randomUUID();
  const pending = f.store.preview(f.project.id, '{{char}} cat', { characterName: '林夏' }, requestId);
  const rejected = assert.rejects(pending, /取消/);
  try {
    assert.equal(f.store.cancel(f.project.id, requestId), true);
    assert.equal(f.store.cancel(f.project.id, requestId), false);
    assert.equal(f.workerStarts(), 0);
  } finally { hold.resolve(); }
  await blocker; await rejected;
  assert.equal(f.workerStarts(), 0);
  assert.equal((await f.store.preview(f.project.id, 'cat')).applied, 'cat');
  assert.equal(f.workerStarts(), 1);
});

test('正则预览：跨书取消不能终止本书请求，同书重复请求不覆盖已有会话', async () => {
  const gate = new OperationGate(), hold = deferred(), blocker = gate.exclusive(() => hold.promise);
  const f = await fixture(gate), requestId = randomUUID();
  const pending = f.store.preview(f.project.id, '{{char}} cat', { characterName: '林夏' }, requestId);
  try {
    assert.equal(f.store.cancel(f.other.id, requestId), false);
    await assert.rejects(f.store.preview(f.project.id, '不可覆盖', {}, requestId), /已有|处理|预览/);
    await assert.rejects(f.store.preview(f.project.id, '另一编号也不能覆盖', {}, randomUUID()), /已有|处理|预览/);
    assert.equal(f.workerStarts(), 0);
  } finally { hold.resolve(); }
  await blocker;
  const result = await pending;
  assert.equal(result.projectId, f.project.id); assert.equal(result.requestId, requestId);
  assert.equal(result.expanded, '林夏 cat'); assert.equal(f.workerStarts(), 1);
  assert.equal(f.store.cancel(f.project.id, requestId), false);
});

test('正则预览：等待文件上下文期间取消，不启动worker也不返回结果', async () => {
  const f = await fixture(); await f.store.import(f.project.id, scripts);
  const original = await fs.readFile(f.file), entered = deferred(), resume = deferred();
  const readNotes = f.workspace.readNotes.bind(f.workspace);
  f.workspace.readNotes = async id => { entered.resolve(); await resume.promise; return readNotes(id); };
  const requestId = randomUUID(), pending = f.store.preview(f.project.id, 'cat', {}, requestId);
  const rejected = assert.rejects(pending, /取消/);
  try { await entered.promise; assert.equal(f.store.cancel(f.project.id, requestId), true); }
  finally { resume.resolve(); }
  await rejected;
  assert.equal(f.workerStarts(), 0); assert.deepEqual(await fs.readFile(f.file), original);
});

test('正则预览：迟到worker结果拒绝预览期间变化的脚本或小说归属', async t => {
  for (const mutation of ['scripts', 'project-identity'] as const) await t.test(mutation, async () => {
    const f = await fixture(); await f.store.import(f.project.id, scripts);
    const original = await fs.readFile(f.file), waiting = await pendingWorkerResult(f);
    const pending = f.store.preview(f.project.id, '{{char}} cat', { characterName: '林夏' }, randomUUID());
    const rejected = assert.rejects(pending, /变化|归属|小说/);
    let changedFile: string, changedBytes: Buffer;
    try {
      await waiting.ready;
      if (mutation === 'scripts') {
        changedFile = f.file;
        changedBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, projectId: f.project.id, scripts: [{ findRegex: 'cat', replaceString: '外部最新' }] }));
      } else {
        changedFile = path.join(f.project.root, '小说资料/project.json');
        const project = JSON.parse(await fs.readFile(changedFile, 'utf8'));
        changedBytes = Buffer.from(JSON.stringify({ ...project, id: randomUUID() }));
      }
      await fs.writeFile(changedFile, changedBytes);
    } finally { waiting.release(); }
    await rejected;
    assert.deepEqual(await fs.readFile(changedFile!), changedBytes!);
    if (mutation === 'project-identity') assert.deepEqual(await fs.readFile(f.file), original);
    assert.equal(f.runner.activeCount, 0);
  });
});

test('正则导入：目标未知版本不能被合法旧数组覆盖', async () => {
  const f = await fixture();
  const future = Buffer.from(JSON.stringify({ schemaVersion: 99, projectId: f.project.id, scripts, annotation: '保留未知格式原件' }));
  await fs.writeFile(f.file, future);
  await assert.rejects(f.store.import(f.project.id, scripts), /版本/);
  assert.deepEqual(await fs.readFile(f.file), future);
});

test('正则导入：新文件显式归属，替换前保留包含未知注释的原始字节', async () => {
  const f = await fixture(), original = Buffer.from('[\n  {"findRegex":"cat", "replaceString":"旧值", "communityExtra":{"keep":true}}\n]\n');
  await fs.writeFile(f.file, original);
  await f.store.import(f.project.id, scripts);
  const stored = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.equal(stored.schemaVersion, 1); assert.equal(stored.projectId, f.project.id);
  assert.equal(stored.scripts[0].replaceString, '猫');
  const history = path.join(f.project.root, '小说资料/正则脚本历史'), names = await fs.readdir(history);
  assert.equal(names.length, 1); assert.deepEqual(await fs.readFile(path.join(history, names[0]!)), original);
});

test('正则导入：保存期间正式文件或暂存内容变化时拒绝发布，保留双方', async t => {
  for (const mutation of ['current', 'stage'] as const) await t.test(mutation, async () => {
    const f = await fixture(); await f.store.import(f.project.id, scripts);
    const original = await fs.readFile(f.file), outside = Buffer.from(JSON.stringify({ schemaVersion: 1, projectId: f.project.id, scripts: [{ findRegex: 'cat', replaceString: '外部修改' }] }));
    const internal = f.store as unknown as { directory(directory: string, create?: boolean): Promise<unknown> };
    const directory = internal.directory.bind(internal);
    let changed = false;
    internal.directory = async (folder, create) => {
      const result = await directory(folder, create);
      if (!changed && create && path.basename(folder) === '正则脚本历史') {
        changed = true;
        if (mutation === 'current') await fs.writeFile(f.file, outside);
        else {
          const names = await fs.readdir(path.dirname(f.file)), temporary = names.find(name => /^\.正则脚本-.+\.tmp$/u.test(name));
          assert.ok(temporary); await fs.writeFile(path.join(path.dirname(f.file), temporary), outside);
        }
      }
      return result;
    };
    await assert.rejects(f.store.import(f.project.id, [{ findRegex: 'cat', replaceString: '新导入' }]), /变化|暂存/);
    assert.equal(changed, true);
    assert.deepEqual(await fs.readFile(f.file), mutation === 'current' ? outside : original);
    const history = path.join(f.project.root, '小说资料/正则脚本历史'), names = await fs.readdir(history);
    assert.equal(names.length, 1); assert.deepEqual(await fs.readFile(path.join(history, names[0]!)), original);
    assert.ok((await fs.readdir(path.dirname(f.file))).some(name => /^\.正则脚本-.+\.tmp$/u.test(name)));
  });
});

test('正则导入：链接目标和超限输入拒绝，原文件与链接外内容不变', async t => {
  await t.test('target-link', async () => {
    const f = await fixture(), outside = path.join(f.root, '不能写入的外部目录'); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, '保留.txt'), '其他书的内容');
    await fs.symlink(outside, f.file, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.store.import(f.project.id, scripts), /链接|文件|目录/);
    assert.equal(await fs.readFile(path.join(outside, '保留.txt'), 'utf8'), '其他书的内容');
    assert.deepEqual(await fs.readdir(outside), ['保留.txt']);
  });
  await t.test('limits', async () => {
    const f = await fixture(); await f.store.import(f.project.id, scripts); const original = await fs.readFile(f.file);
    await assert.rejects(f.store.import(f.project.id, Array.from({ length: 257 }, () => ({ findRegex: 'cat', replaceString: '' }))), /256|上限|超过/);
    await assert.rejects(f.store.import(f.project.id, [{ findRegex: 'a'.repeat(8193), replaceString: '' }]), /上限|超过/);
    await assert.rejects(f.store.import(f.project.id, [{ findRegex: 'cat', replaceString: 'x'.repeat(32769) }]), /上限|超过/);
    assert.deepEqual(await fs.readFile(f.file), original);
    await fs.writeFile(f.file, Buffer.alloc(1024 * 1024 + 1, 0x20)); const oversized = await fs.readFile(f.file);
    await assert.rejects(f.store.read(f.project.id), /1 MiB|超/);
    await assert.rejects(f.store.import(f.project.id, scripts), /1 MiB|超/);
    assert.deepEqual(await fs.readFile(f.file), oversized);
  });
});
