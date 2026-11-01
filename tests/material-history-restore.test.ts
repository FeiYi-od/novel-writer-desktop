import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import mutableFs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workspace } from '../src/main/workspace';
import { MaterialSyncService } from '../src/main/material-sync';

async function fixture() {
  const root = await fs.mkdtemp(path.resolve('.artifacts/material-restore-059-'));
  const book = path.join(root, '虚构书'), otherBook = path.join(root, '另一虚构书');
  await fs.mkdir(book); await fs.mkdir(otherBook);
  const data = path.join(root, 'data'), materials = path.join(data, '创作资料');
  const workspace = new Workspace(data, materials); await workspace.initialize();
  const project = await workspace.attach(book), other = await workspace.attach(otherBook);
  const service = new MaterialSyncService(workspace, materials, data);
  const canonical = path.join(materials, project.id), historyRoot = path.join(materials, '同步历史', project.id);
  const historyId = randomUUID(), history = path.join(historyRoot, historyId);
  await fs.mkdir(canonical, { recursive: true }); await fs.mkdir(history, { recursive: true });
  await fs.writeFile(path.join(canonical, '当前.txt'), '虚构现在内容\r\n');
  await fs.writeFile(path.join(history, '旧设定.txt'), '虚构历史内容\r\n');
  await fs.writeFile(path.join(history, '草稿.json'), JSON.stringify({ schemaVersion: 1, projectId: project.id, confirmed: false, text: '未确认' }));
  await service.configure(project.id, false);
  const statePath = path.join(data, 'material-sync', `${project.id}.json`), state = await fs.readFile(statePath);
  const pending = path.join(data, 'material-sync', `${project.id}-pending.json`);
  const preview = await service.previewHistory({ projectId: project.id, source: 'local', id: historyId });
  const request = { projectId: project.id, source: 'local' as const, id: historyId, fingerprint: preview.fingerprint };
  return { root, book, otherBook, data, materials, project, other, workspace, service, canonical, history, historyRoot, historyId, statePath, state, pending, request };
}

test('用户确认换入历史：整个固定资料原目录有备份，原历史及未确认状态原字节保留，基线不变', async () => {
  const f = await fixture(), historyBytes = await fs.readFile(path.join(f.history, '草稿.json'));
  const result = await f.service.restoreHistory(f.request);
  assert.deepEqual({ ...result, backupId: null }, { schemaVersion: 1, projectId: f.project.id, source: 'local', id: f.historyId, backupId: null, changed: true });
  assert.ok(result.backupId);
  const backup = path.join(f.historyRoot, result.backupId);
  assert.equal(await fs.readFile(path.join(backup, '当前.txt'), 'utf8'), '虚构现在内容\r\n');
  assert.equal(await fs.readFile(path.join(f.canonical, '旧设定.txt'), 'utf8'), '虚构历史内容\r\n');
  assert.deepEqual(await fs.readFile(path.join(f.canonical, '草稿.json')), historyBytes);
  assert.equal(JSON.parse(historyBytes.toString()).confirmed, false);
  assert.deepEqual(await fs.readFile(path.join(f.history, '草稿.json')), historyBytes);
  assert.deepEqual(await fs.readFile(f.statePath), f.state);
  await assert.rejects(fs.stat(f.pending), { code: 'ENOENT' });
  const versions = await f.service.history(f.project.id);
  assert.ok(versions.versions.some(v => v.id === result.backupId && v.location === 'active'));
});

test('历史同版本不换入；跨书、过期预览、同步中断、损坏保留记录均拒绝且不改变原文件', async () => {
  const f = await fixture();
  await assert.rejects(async () => f.service.restoreHistory({ ...f.request, projectId: f.other.id }));
  await fs.writeFile(f.pending, '损坏记录'); await assert.rejects(f.service.restoreHistory(f.request), /换入记录/u);
  assert.equal(await fs.readFile(f.pending, 'utf8'), '损坏记录'); await fs.unlink(f.pending);
  const retention = path.join(f.data, 'material-sync', `${f.project.id}-retention.json`);
  await fs.writeFile(retention, '损坏记录'); await assert.rejects(f.service.restoreHistory(f.request), /保留记录/u); await fs.unlink(retention);
  await fs.writeFile(path.join(f.canonical, '当前.txt'), '外部修改');
  await assert.rejects(f.service.restoreHistory(f.request), /变化/u);
  assert.equal(await fs.readFile(path.join(f.canonical, '当前.txt'), 'utf8'), '外部修改');
  assert.equal(await fs.readFile(path.join(f.history, '旧设定.txt'), 'utf8'), '虚构历史内容\r\n');
  assert.deepEqual(await fs.readFile(f.statePath), f.state);
});

test('恢复后的同一历史再次选择时不产生重复备份或暂存', async () => {
  const f = await fixture(); await f.service.restoreHistory(f.request);
  const preview = await f.service.previewHistory({ projectId: f.project.id, source: 'local', id: f.historyId });
  const before = (await fs.readdir(f.historyRoot)).sort();
  const result = await f.service.restoreHistory({ ...f.request, fingerprint: preview.fingerprint });
  assert.equal(result.changed, false); assert.equal(result.backupId, null);
  assert.deepEqual((await fs.readdir(f.historyRoot)).sort(), before);
  assert.deepEqual(await fs.readFile(f.statePath), f.state);
});

test('传输历史可手动换入：保留传输清单与父链、基线不变且换前资料独立备份', async () => {
  const f = await fixture(); await f.service.configure(f.project.id, true);
  await f.service.synchronize({ projectId: f.project.id });
  const before = await f.service.status(f.project.id); assert.equal(before.remoteRevisions.length, 1);
  const revision = before.remoteRevisions[0].id;
  const revisionRoot = path.join(f.book, '小说资料', '创作资料同步', '版本', revision);
  const rawManifest = await fs.readFile(path.join(revisionRoot, 'manifest.json'));
  const state = await fs.readFile(f.statePath);
  await fs.writeFile(path.join(f.canonical, '当前.txt'), '需要备份的新版本');
  const preview = await f.service.previewHistory({ projectId: f.project.id, source: 'transport', id: revision });
  const result = await f.service.restoreHistory({ projectId: f.project.id, source: 'transport', id: revision, fingerprint: preview.fingerprint });
  assert.equal(result.changed, true); assert.ok(result.backupId);
  assert.equal(await fs.readFile(path.join(f.historyRoot, result.backupId, '当前.txt'), 'utf8'), '需要备份的新版本');
  assert.equal(await fs.readFile(path.join(f.canonical, '当前.txt'), 'utf8'), '虚构现在内容\r\n');
  assert.deepEqual(await fs.readFile(path.join(revisionRoot, 'manifest.json')), rawManifest);
  assert.deepEqual(await fs.readFile(f.statePath), state);
});

test('保留区历史换入后仍在保留区；原固定目录缺失时明确拒绝换入', async () => {
  const f = await fixture(); await f.service.retainHistory({ projectId: f.project.id, id: f.historyId, fingerprint: f.request.fingerprint });
  const retained = path.join(f.materials, '同步历史保留', f.project.id, f.historyId);
  const preview = await f.service.previewHistory({ projectId: f.project.id, source: 'local', id: f.historyId });
  const result = await f.service.restoreHistory({ ...f.request, fingerprint: preview.fingerprint });
  assert.ok(result.backupId);
  assert.equal(await fs.readFile(path.join(retained, '旧设定.txt'), 'utf8'), '虚构历史内容\r\n');
  assert.equal(await fs.readFile(path.join(f.historyRoot, result.backupId, '当前.txt'), 'utf8'), '虚构现在内容\r\n');
  const g = await fixture(); await fs.rename(g.canonical, g.canonical + '-外部原件');
  const missing = await g.service.previewHistory({ projectId: g.project.id, source: 'local', id: g.historyId });
  await assert.rejects(g.service.restoreHistory({ ...g.request, fingerprint: missing.fingerprint }), /不存在|备份/u);
  assert.equal(await fs.readFile(path.join(g.canonical + '-外部原件', '当前.txt'), 'utf8'), '虚构现在内容\r\n');
  assert.equal(await fs.readFile(path.join(g.history, '旧设定.txt'), 'utf8'), '虚构历史内容\r\n');
});

test('写入 pending 后最终核对期间历史源发生变化：拒绝换入，保留原件和同步基线', async () => {
  const f = await fixture(), service = f.service as any, original = service.dagDirectoryIdentity.bind(service); let injected = false;
  service.dagDirectoryIdentity = async (directory: string) => {
    const result = await original(directory);
    if (!injected && path.resolve(directory) === path.resolve(f.history)) {
      try { await fs.lstat(f.pending); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result; throw error; }
      await fs.writeFile(path.join(f.history, '旧设定.txt'), '外部改写的历史'); injected = true;
    }
    return result;
  };
  await assert.rejects(f.service.restoreHistory(f.request), /变化|核对/u); assert.equal(injected, true);
  assert.equal(await fs.readFile(path.join(f.canonical, '当前.txt'), 'utf8'), '虚构现在内容\r\n');
  assert.equal(await fs.readFile(path.join(f.history, '旧设定.txt'), 'utf8'), '外部改写的历史');
  assert.deepEqual(await fs.readFile(f.statePath), f.state);
});

test('备份所在历史目录在最终核对期间被同内容替换：拒绝换入', async () => {
  const f = await fixture(); await f.service.configure(f.project.id, true); await f.service.synchronize({ projectId: f.project.id });
  const status = await f.service.status(f.project.id), revision = status.remoteRevisions[0].id;
  await fs.writeFile(path.join(f.canonical, '当前.txt'), '需要保留的当前内容');
  const preview = await f.service.previewHistory({ projectId: f.project.id, source: 'transport', id: revision });
  const folder = path.join(f.book, '小说资料', '创作资料同步', '版本', revision);
  const oldRoot = f.historyRoot + '-外部原目录';
  const service = f.service as any, original = service.dagDirectoryIdentity.bind(service); let injected = false;
  service.dagDirectoryIdentity = async (directory: string) => {
    const value = await original(directory);
    if (!injected && path.resolve(directory) === path.resolve(folder)) {
      try { await fs.lstat(f.pending); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return value; throw error; }
      await fs.rename(f.historyRoot, oldRoot); await fs.cp(oldRoot, f.historyRoot, { recursive: true, force: false }); injected = true;
    }
    return value;
  };
  await assert.rejects(f.service.restoreHistory({ projectId: f.project.id, source: 'transport', id: revision, fingerprint: preview.fingerprint }), /变化|目录/u);
  assert.equal(injected, true);
  assert.equal(await fs.readFile(path.join(f.canonical, '当前.txt'), 'utf8'), '需要保留的当前内容');
  assert.equal(await fs.readFile(path.join(oldRoot, f.historyId, '旧设定.txt'), 'utf8'), '虚构历史内容\r\n');
  assert.equal(await fs.readFile(path.join(f.historyRoot, f.historyId, '旧设定.txt'), 'utf8'), '虚构历史内容\r\n');
});

test('历史或当前目录含嵌套空目录时拒绝，不能静默遗漏目录', async () => {
  for (const source of ['canonical', 'history'] as const) {
    const f = await fixture(); await fs.mkdir(path.join(f[source], '空目录'));
    const preview = await f.service.previewHistory({ projectId: f.project.id, source: 'local', id: f.historyId });
    await assert.rejects(f.service.restoreHistory({ ...f.request, fingerprint: preview.fingerprint }), /空目录/u);
    assert.ok((await fs.stat(path.join(f[source], '空目录'))).isDirectory());
    assert.deepEqual(await fs.readFile(f.statePath), f.state);
  }
});

for (const after of [false, true]) test(`暂存换入${after ? '后' : '前'}发生异常：原资料有保障、同步基线不变`, async () => {
  const f = await fixture(), original = mutableFs.rename;
  mutableFs.rename = async (...args: Parameters<typeof mutableFs.rename>) => {
    if (path.basename(String(args[0])).startsWith(`sync-stage-${f.project.id}-`) && path.resolve(String(args[1])) === path.resolve(f.canonical)) {
      if (after) await original(...args);
      throw new Error('模拟换入中断');
    }
    return original(...args);
  };
  try { await assert.rejects(f.service.restoreHistory(f.request), /模拟换入中断/u); } finally { mutableFs.rename = original; }
  assert.deepEqual(await fs.readFile(f.statePath), f.state);
  if (!after) assert.equal(await fs.readFile(path.join(f.canonical, '当前.txt'), 'utf8'), '虚构现在内容\r\n');
  else {
    assert.equal(await fs.readFile(path.join(f.canonical, '旧设定.txt'), 'utf8'), '虚构历史内容\r\n');
    assert.ok((await fs.stat(f.pending)).isFile()); await f.service.status(f.project.id);
    await assert.rejects(fs.stat(f.pending), { code: 'ENOENT' });
    const names = await fs.readdir(f.historyRoot); assert.equal(names.length, 2);
    const backupId = names.find(name => name !== f.historyId)!;
    assert.equal(await fs.readFile(path.join(f.historyRoot, backupId, '当前.txt'), 'utf8'), '虚构现在内容\r\n');
  }
  assert.equal(await fs.readFile(path.join(f.history, '旧设定.txt'), 'utf8'), '虚构历史内容\r\n');
});
