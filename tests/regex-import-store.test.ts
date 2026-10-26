import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Workspace } from '../src/main/workspace';
import { MacroStore } from '../src/main/macros';
import { RegexPreviewRunner } from '../src/main/regex-preview';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const scripts = [{ findRegex: '/旧/g', replaceString: '原稿' }];
const incoming = () => ({ id: randomUUID(), scriptName: '虚构社区正则', findRegex: '/cat/gi', replaceString: '猫',
  placement: [1, 2], promptOnly: true, customExtension: { text: '这段未知数据须保留', enabled: true } });
async function fixture() {
  const root = await fs.mkdtemp(path.resolve('.artifacts/regex-import-store-043-'));
  const data = path.join(root, 'profile'), book = path.join(root, '虚构社区导入书'); await fs.mkdir(book);
  const workspace = new Workspace(data, path.join(data, '创作资料')); await workspace.initialize();
  const project = await workspace.attach(book);
  const runner = new RegexPreviewRunner(() => { throw new Error('Import must not start a worker'); });
  const store = new MacroStore(workspace, runner), active = path.join(book, '小说资料/正则脚本.json');
  const copies = path.join(book, '小说资料/正则导入原件');
  return { root, data, book, workspace, project, store, active, copies };
}

test('社区导入：最终活动脚本复核期间原件或清单变化不能发布新活动脚本', async t => {
  for (const target of ['source', 'manifest'] as const) await t.test(target, async () => {
    const f = await fixture(); await f.store.import(f.project.id, scripts);
    const before = await fs.readFile(f.active), bytes = Buffer.from(JSON.stringify(incoming()));
    const internal = f.store as any, snapshot = internal.snapshot.bind(internal);
    let reads = 0, changedFile = '';
    internal.snapshot = async (id: string) => {
      const value = await snapshot(id);
      if (++reads === 2) {
        const names = await fs.readdir(f.copies); assert.equal(names.length, 1);
        changedFile = path.join(f.copies, names[0], target === 'source' ? '原始正则.json' : 'manifest.json');
        await fs.appendFile(changedFile, '\n外部并发变更');
      }
      return value;
    };
    await assert.rejects(f.store.importBytes(f.project.id, bytes), /变化|变更/);
    assert.ok(changedFile); assert.ok((await fs.readFile(changedFile, 'utf8')).endsWith('外部并发变更'));
    assert.deepEqual(await fs.readFile(f.active), before, '失败保留原活动脚本原字节');
  });
});

test('社区导入：单条BOM/CRLF原JSON及扩展字段原字节保留，清单绑定小说和SHA', async () => {
  const f = await fixture(), value = incoming();
  const chapter = await f.workspace.createChapter(f.project.id, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '\u3000\u3000虚构正文必须保留原字节。' }] }] });
  const chapterFile = path.join(f.book, chapter.path), manuscript = await fs.readFile(chapterFile);
  const bytes = Buffer.from('\uFEFF' + JSON.stringify(value, null, 2).replace(/\n/gu, '\r\n') + '\r\n');
  const result = await f.store.importBytes(f.project.id, bytes);
  assert.equal(result.schemaVersion, 1); assert.equal(result.projectId, f.project.id); assert.equal(result.format, 'single'); assert.equal(result.count, 1);
  assert.equal(path.basename(result.sourceFile), '原始正则.json');
  const relative = path.relative(f.copies, result.sourceFile);
  assert.ok(relative && !path.isAbsolute(relative) && !relative.startsWith('..'));
  assert.deepEqual(await fs.readFile(result.sourceFile), bytes); assert.equal(result.sourceSha256, hash(bytes));
  const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(result.sourceFile), 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.projectId, f.project.id); assert.equal(manifest.kind, 'regex-import-source');
  assert.equal(manifest.sha256, hash(bytes)); assert.equal(manifest.bytes, bytes.length); assert.equal(manifest.format, 'single'); assert.equal(manifest.scripts, 1);
  const active = JSON.parse(await fs.readFile(f.active, 'utf8'));
  assert.equal(active.schemaVersion, 1); assert.equal(active.projectId, f.project.id);
  assert.equal(active.scripts.length, 1); assert.equal(active.scripts[0].findRegex, value.findRegex); assert.equal(active.scripts[0].replaceString, value.replaceString);
  assert.equal(Object.hasOwn(active.scripts[0], 'placement'), false); assert.equal(Object.hasOwn(active.scripts[0], 'customExtension'), false);
  assert.ok(result.unsupportedFieldCount >= 2); assert.ok(result.unsupportedFields.some(name => name.includes('placement')));
  assert.deepEqual(await fs.readFile(chapterFile), manuscript);
});

test('社区导入：替换前的旧数组原raw完整归档，源清单不把副本写成活动成功状态', async () => {
  const f = await fixture(), old = Buffer.from('\uFEFF' + JSON.stringify(scripts, null, 4).replace(/\n/gu, '\r\n') + '\r\n');
  await fs.writeFile(f.active, old);
  const result = await f.store.importBytes(f.project.id, Buffer.from(JSON.stringify({ scripts: [incoming()] })));
  assert.equal(result.format, 'scripts');
  const history = path.join(f.book, '小说资料/正则脚本历史'), names = await fs.readdir(history); assert.equal(names.length, 1);
  assert.deepEqual(await fs.readFile(path.join(history, names[0])), old);
  const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(result.sourceFile), 'manifest.json'), 'utf8'));
  assert.equal(manifest.kind, 'regex-import-source');
  assert.equal(Object.hasOwn(manifest, 'activeSuccess'), false);
});

test('社区导入：未知现有版本和显式错书incoming均拒绝，活动原件保持', async t => {
  for (const target of ['future-target', 'foreign-input'] as const) await t.test(target, async () => {
    const f = await fixture();
    const before = Buffer.from(JSON.stringify({ schemaVersion: target === 'future-target' ? 99 : 1, projectId: f.project.id, scripts }));
    await fs.writeFile(f.active, before);
    const value = target === 'future-target' ? [incoming()] : { schemaVersion: 1, projectId: randomUUID(), scripts: [incoming()] };
    await assert.rejects(f.store.importBytes(f.project.id, Buffer.from(JSON.stringify(value))), /版本|归属|另一部|小说/);
    assert.deepEqual(await fs.readFile(f.active), before);
    await assert.rejects(fs.access(f.copies), { code: 'ENOENT' });
  });
});

test('社区导入：原件根目录junction拒绝，链接目标和旧活动脚本不变', async () => {
  const f = await fixture(); await f.store.import(f.project.id, scripts);
  const before = await fs.readFile(f.active), outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, f.copies, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.store.importBytes(f.project.id, Buffer.from(JSON.stringify(incoming()))), /链接|越界/);
  assert.deepEqual(await fs.readFile(f.active), before); assert.deepEqual(await fs.readdir(outside), []);
});

test('社区导入：复制期间替换原件目录身份时拒绝并保留两份暂存', async () => {
  const f = await fixture(); await f.store.import(f.project.id, scripts); const before = await fs.readFile(f.active);
  const internal = f.store as any, regular = internal.regular.bind(internal); let moved = '';
  internal.regular = async (file: string) => {
    const result = await regular(file);
    if (!moved && path.basename(file) === '原始正则.json') {
      moved = path.dirname(file); await fs.rename(moved, moved + '-原件'); await fs.mkdir(moved);
      await fs.writeFile(file, result.raw, { flag: 'wx' });
    }
    return result;
  };
  await assert.rejects(f.store.importBytes(f.project.id, Buffer.from(JSON.stringify(incoming()))), /变化|身份/);
  assert.ok(moved); assert.deepEqual(await fs.readFile(f.active), before);
  assert.deepEqual(await fs.readFile(path.join(moved, '原始正则.json')), await fs.readFile(path.join(moved + '-原件', '原始正则.json')));
  await assert.rejects(fs.access(path.join(moved, 'manifest.json')), { code: 'ENOENT' });
});

test('社区导入：超限原件与无效UTF8在创建source copy前拒绝', async () => {
  const f = await fixture(); await f.store.import(f.project.id, scripts); const before = await fs.readFile(f.active);
  await assert.rejects(f.store.importBytes(f.project.id, Buffer.alloc(1024 * 1024 + 1, 0x20)), /1 MiB|超/);
  await assert.rejects(f.store.importBytes(f.project.id, Buffer.from([0xff, 0xfe])), /UTF-8|JSON/);
  assert.deepEqual(await fs.readFile(f.active), before); await assert.rejects(fs.access(f.copies), { code: 'ENOENT' });
});
