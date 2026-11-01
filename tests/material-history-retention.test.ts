import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import fsMutable from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workspace } from '../src/main/workspace';
import { MaterialSyncService } from '../src/main/material-sync';
import { parseMaterialHistoryDag } from '../src/main/material-history-dag';

async function fixture() {
  const root = await fs.mkdtemp(path.resolve('.artifacts/material-retention-058-'));
  const data = path.join(root, 'profile'), materials = path.join(data, '创作资料'), book = path.join(root, '虚构书');
  await fs.mkdir(book); const workspace = new Workspace(data, materials); await workspace.initialize();
  const project = await workspace.attach(book), service = new MaterialSyncService(workspace, materials, data), id = randomUUID();
  const active = path.join(materials, '同步历史', project.id), retained = path.join(materials, '同步历史保留', project.id);
  const folder = path.join(active, id), canonical = path.join(materials, project.id);
  await fs.mkdir(path.join(folder, 'nested'), { recursive: true });
  await fs.writeFile(path.join(folder, 'nested', '故事.txt'), '虚构历史原始内容\r\n');
  await fs.mkdir(canonical, { recursive: true }); await fs.writeFile(path.join(canonical, '当前.txt'), '虚构当前内容');
  const preview = await service.previewHistory({ projectId: project.id, source: 'local', id });
  return { root, data, materials, book, workspace, project, service, id, active, retained, folder, canonical, preview,
    request: { projectId: project.id, id, fingerprint: preview.fingerprint }, journal: path.join(data, 'material-sync', `${project.id}-retention.json`),
    pending: path.join(data, 'material-sync', `${project.id}-pending.json`) };
}

test('单份本机历史移入保留区后仍可预览、导出完整历史；只释放活动名额且保留字节', async () => {
  const f = await fixture(), before = await fs.readFile(path.join(f.folder, 'nested', '故事.txt'));
  const result = await f.service.retainHistory(f.request);
  assert.deepEqual(result, { schemaVersion: 1, projectId: f.project.id, id: f.id, location: 'retained', files: 1, bytes: before.length });
  await assert.rejects(fs.lstat(f.folder), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(path.join(f.retained, f.id, 'nested', '故事.txt')), before);
  const capacity = await f.service.capacity(f.project.id); assert.equal(capacity.local.entries, 0);
  const listing = await f.service.history(f.project.id); assert.equal(listing.versions[0]?.location, 'retained');
  const preview = await f.service.previewHistory({ projectId: f.project.id, source: 'local', id: f.id });
  assert.notEqual(preview.fingerprint, f.preview.fingerprint); assert.equal(preview.files.find(item => item.path === 'nested/故事.txt')?.historyBytes, before.length);
  const dagPreview = await f.service.previewHistoryDag(f.project.id); assert.equal(dagPreview.localArchives, 1);
  const archived = await f.service.archiveHistoryDag({ projectId: f.project.id, fingerprint: dagPreview.fingerprint });
  const archive = await parseMaterialHistoryDag(await fs.readFile(archived.file), await fs.readFile(path.join(archived.directory, '完成清单.json')), f.project.id);
  assert.equal(archive.manifest.local[0]?.id, f.id);
  assert.deepEqual(await fs.readFile(path.join(f.retained, f.id, 'nested', '故事.txt')), before);
  await assert.rejects(fs.lstat(f.journal), { code: 'ENOENT' });
});

test('同步 pending 即使损坏也拒绝移动；过期预览、跨书和重复ID不移动原件', async () => {
  const f = await fixture(); await fs.mkdir(path.dirname(f.pending), { recursive: true }); await fs.writeFile(f.pending, '{损坏的换入记录');
  await assert.rejects(f.service.retainHistory(f.request), /换入记录/u);
  assert.equal(await fs.readFile(f.pending, 'utf8'), '{损坏的换入记录'); await fs.unlink(f.pending);
  await fs.writeFile(path.join(f.canonical, '当前.txt'), '外部更改');
  await assert.rejects(f.service.retainHistory(f.request), /变化/u);
  await assert.rejects(async () => f.service.retainHistory({ ...f.request, projectId: randomUUID() }));
  await fs.mkdir(path.join(f.retained, f.id), { recursive: true });
  await assert.rejects(f.service.history(f.project.id), /重复/u);
  await assert.rejects(f.service.retainHistory(f.request), /重复|变化/u);
  assert.equal(await fs.readFile(path.join(f.folder, 'nested', '故事.txt'), 'utf8'), '虚构历史原始内容\r\n');
});

test('包含空目录的旧历史拒绝转移，避免完整历史包遗漏；硬链接拒绝', async () => {
  const f = await fixture(); await fs.mkdir(path.join(f.folder, '空目录'));
  const preview = await f.service.previewHistory({ projectId: f.project.id, source: 'local', id: f.id });
  await assert.rejects(f.service.retainHistory({ ...f.request, fingerprint: preview.fingerprint }), /空目录/u);
  assert.ok((await fs.stat(path.join(f.folder, '空目录'))).isDirectory());
  const g = await fixture(); await fs.link(path.join(g.folder, 'nested', '故事.txt'), path.join(g.folder, 'nested', '硬链接.txt'));
  const gp = await g.service.previewHistory({ projectId: g.project.id, source: 'local', id: g.id });
  await assert.rejects(g.service.retainHistory({ ...g.request, fingerprint: gp.fingerprint }), /硬链接/u);
  assert.ok((await fs.stat(path.join(g.folder, 'nested', '故事.txt'))).isFile());
});

for (const after of [false, true]) test(`模拟${after ? '重命名后' : '重命名前'}中断：只读接口拒绝，历史入口核验后恢复`, async () => {
  const f = await fixture(), original = fsMutable.rename;
  fsMutable.rename = async (...args: Parameters<typeof fsMutable.rename>) => {
    if (path.resolve(String(args[0])) === path.resolve(f.folder)) {
      if (after) await original(...args);
      throw new Error('模拟保留中断');
    }
    return original(...args);
  };
  try { await assert.rejects(f.service.retainHistory(f.request), /模拟保留中断/u); }
  finally { fsMutable.rename = original; }
  const raw = await fs.readFile(f.journal);
  await assert.rejects(f.service.capacity(f.project.id), /保留记录/u);
  await assert.rejects(f.service.previewHistoryDag(f.project.id), /保留记录/u);
  assert.deepEqual(await fs.readFile(f.journal), raw, '只读接口不清理 journal');
  const versions = await f.service.history(f.project.id);
  assert.equal(versions.versions.find(item => item.id === f.id)?.location, after ? 'retained' : 'active');
  await assert.rejects(fs.lstat(f.journal), { code: 'ENOENT' });
  const base = after ? f.retained : f.active;
  assert.equal(await fs.readFile(path.join(base, f.id, 'nested', '故事.txt'), 'utf8'), '虚构历史原始内容\r\n');
});

async function interruptBeforeRename(f: Awaited<ReturnType<typeof fixture>>) {
  const original = fsMutable.rename;
  fsMutable.rename = async (...args: Parameters<typeof fsMutable.rename>) => {
    if (path.resolve(String(args[0])) === path.resolve(f.folder)) throw new Error('模拟中断');
    return original(...args);
  };
  try { await assert.rejects(f.service.retainHistory(f.request), /模拟中断/u); }
  finally { fsMutable.rename = original; }
}

test('恢复最后检查期间外部替换日志：保留新日志和两侧历史，不得误报成功', async () => {
  const f = await fixture(); await interruptBeforeRename(f);
  const service = f.service as any, original = service.noSyncPending.bind(service); let count = 0;
  const replacement = '{外部变化的新记录';
  service.noSyncPending = async (id: string) => { await original(id); if (++count === 3) await fs.writeFile(f.journal, replacement); };
  await assert.rejects(f.service.history(f.project.id), /变化|记录/u);
  assert.equal(await fs.readFile(f.journal, 'utf8'), replacement);
  assert.equal(await fs.readFile(path.join(f.folder, 'nested', '故事.txt'), 'utf8'), '虚构历史原始内容\r\n');
});

test('恢复最后检查期间原缺失的保留根被创建：保留日志和两侧历史', async () => {
  const f = await fixture(); await interruptBeforeRename(f);
  const moved = f.retained + '-临时保留'; await fs.rename(f.retained, moved);
  const service = f.service as any, original = service.noSyncPending.bind(service); let count = 0;
  service.noSyncPending = async (id: string) => {
    await original(id);
    if (++count === 3) { await fs.mkdir(path.join(f.retained, f.id), { recursive: true }); await fs.writeFile(path.join(f.retained, f.id, '外部历史.txt'), '外部历史'); }
  };
  await assert.rejects(f.service.history(f.project.id), /变化|出现|保留/u);
  assert.ok((await fs.stat(f.journal)).isFile());
  assert.equal(await fs.readFile(path.join(f.retained, f.id, '外部历史.txt'), 'utf8'), '外部历史');
  assert.equal(await fs.readFile(path.join(f.folder, 'nested', '故事.txt'), 'utf8'), '虚构历史原始内容\r\n');
});

test('保留前 canonical 目录被同字节重建：拒绝使用旧预览并保留所有文件', async () => {
  const f = await fixture(), service = f.service as any, original = service.noSyncPending.bind(service); let count = 0;
  service.noSyncPending = async (id: string) => {
    await original(id);
    if (++count === 3) {
      await fs.rename(f.canonical, f.canonical + '-原目录'); await fs.mkdir(f.canonical);
      await fs.writeFile(path.join(f.canonical, '当前.txt'), '虚构当前内容');
    }
  };
  await assert.rejects(f.service.retainHistory(f.request), /变化|目录/u);
  assert.equal(await fs.readFile(path.join(f.folder, 'nested', '故事.txt'), 'utf8'), '虚构历史原始内容\r\n');
  assert.equal(await fs.readFile(path.join(f.canonical, '当前.txt'), 'utf8'), '虚构当前内容');
  assert.equal(await fs.readFile(path.join(f.canonical + '-原目录', '当前.txt'), 'utf8'), '虚构当前内容');
  assert.ok((await fs.stat(f.journal)).isFile());
});

test('最后核对书籍归属时源历史被外部修改：拒绝移动且保留外部更新', async () => {
  const f = await fixture(), service = f.service as any, original = service.bookIdentity.bind(service); let injected = false;
  service.bookIdentity = async (...args: any[]) => {
    const result = await original(...args);
    try { await fs.lstat(f.journal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result; throw error; }
    if (!injected) { await fs.writeFile(path.join(f.folder, 'nested', '故事.txt'), '外部更新的虚构历史'); injected = true; }
    return result;
  };
  await assert.rejects(f.service.retainHistory(f.request), /变化|保留/u);
  assert.equal(injected, true);
  assert.equal(await fs.readFile(path.join(f.folder, 'nested', '故事.txt'), 'utf8'), '外部更新的虚构历史');
  await assert.rejects(fs.lstat(path.join(f.retained, f.id)), { code: 'ENOENT' });
  assert.ok((await fs.stat(f.journal)).isFile());
});
