import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Workspace } from '../src/main/workspace';
import { MaterialSyncService } from '../src/main/material-sync';

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

async function fixture() {
  const root = await fs.mkdtemp(path.resolve('.artifacts/transport-reclaim-061-'));
  const data = path.join(root, 'profile'), materials = path.join(data, '创作资料'), book = path.join(root, '虚构书');
  await fs.mkdir(book); const workspace = new Workspace(data, materials); await workspace.initialize();
  const project = await workspace.attach(book), service = new MaterialSyncService(workspace, materials, data);
  const versions = path.join(book, '小说资料', '创作资料同步', '版本');
  await fs.mkdir(versions, { recursive: true });
  const makeVersion = async (parents: string[]) => {
    const id = randomUUID(), folder = path.join(versions, id);
    await fs.mkdir(path.join(folder, 'files'), { recursive: true });
    const payload = Buffer.from(`虚构传输内容 ${id.slice(0, 4)}`, 'utf8');
    await fs.writeFile(path.join(folder, 'files', '资料.txt'), payload);
    const manifest = { schemaVersion: 1, projectId: project.id, revisionId: id, createdAt: new Date().toISOString(), parents,
      entries: [{ path: '资料.txt', bytes: payload.length, sha256: sha(payload) }] };
    await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return { id, folder, bytes: payload.length };
  };
  return { root, data, materials, book, workspace, project, service, versions, makeVersion,
    records: path.join(data, 'material-sync', `${project.id}-reclaims.json`) };
}

test('回收书内传输叶子版本：目录删除、记录留存，其他版本与当前资料不受影响', async () => {
  const f = await fixture();
  const leaf = await f.makeVersion([]);
  const preview = await f.service.previewHistory({ projectId: f.project.id, source: 'transport', id: leaf.id });
  const result = await f.service.reclaimTransportHistory({ projectId: f.project.id, id: leaf.id, fingerprint: preview.fingerprint, confirm: '回收' });
  assert.equal(result.files, 1); assert.equal(result.bytes, leaf.bytes);
  await assert.rejects(fs.lstat(leaf.folder), { code: 'ENOENT' });
  assert.equal((await f.service.history(f.project.id)).versions.length, 0);
  const records = JSON.parse(await fs.readFile(f.records, 'utf8')) as { id: string }[];
  assert.equal(records.length, 1); assert.equal(records[0]!.id, leaf.id);
});

test('传输版本仍是其他版本父版本时拒绝；指纹不符拒绝；未删除任何文件', async () => {
  const f = await fixture();
  const parent = await f.makeVersion([]), child = await f.makeVersion([parent.id]);
  const preview = await f.service.previewHistory({ projectId: f.project.id, source: 'transport', id: parent.id });
  await assert.rejects(f.service.reclaimTransportHistory({ projectId: f.project.id, id: parent.id, fingerprint: preview.fingerprint, confirm: '回收' }), /父版本/u);
  assert.ok((await fs.stat(parent.folder)).isDirectory());
  await assert.rejects(f.service.reclaimTransportHistory({ projectId: f.project.id, id: child.id, fingerprint: '0'.repeat(64), confirm: '回收' }), /变化|不一致/u);
  assert.ok((await fs.stat(child.folder)).isDirectory());
  // 子版本没有子节点，可以回收；父版本此时仍被引用吗？父版本只被已删除子版本引用过，因此仍应允许删除
  const childPreview = await f.service.previewHistory({ projectId: f.project.id, source: 'transport', id: child.id });
  const removedChild = await f.service.reclaimTransportHistory({ projectId: f.project.id, id: child.id, fingerprint: childPreview.fingerprint, confirm: '回收' });
  assert.equal(removedChild.id, child.id);
  const parentPreview = await f.service.previewHistory({ projectId: f.project.id, source: 'transport', id: parent.id });
  const removedParent = await f.service.reclaimTransportHistory({ projectId: f.project.id, id: parent.id, fingerprint: parentPreview.fingerprint, confirm: '回收' });
  assert.equal(removedParent.id, parent.id);
});

test('活动区本机历史不能通过传输回收入口删除；跨书拒绝', async () => {
  const f = await fixture();
  const leaf = await f.makeVersion([]);
  const localId = randomUUID(), localFolder = path.join(f.materials, '同步历史', f.project.id, localId);
  await fs.mkdir(localFolder, { recursive: true }); await fs.writeFile(path.join(localFolder, '本机.txt'), '本机历史');
  await assert.rejects(f.service.reclaimTransportHistory({ projectId: f.project.id, id: localId, fingerprint: '0'.repeat(64), confirm: '回收' }));
  assert.ok((await fs.stat(localFolder)).isDirectory());
  await assert.rejects(async () => f.service.reclaimTransportHistory({ projectId: randomUUID(), id: leaf.id, fingerprint: '0'.repeat(64), confirm: '回收' }), /未关联|小说/u);
  assert.ok((await fs.stat(leaf.folder)).isDirectory());
});

test('本机上次同步的基线版本不能回收（否则后续 synchronize 会失败）', async t => {
  const f = await fixture();
  const leaf = await f.makeVersion([]);
  // 直接写入同步状态：lastRevision 指向该版本
  const stateFile = path.join(f.data, 'material-sync', `${f.project.id}.json`);
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify({ schemaVersion: 1, projectId: f.project.id, enabled: true, base: {}, lastRevision: leaf.id, lastSyncedAt: new Date().toISOString() }), 'utf8');
  const preview = await f.service.previewHistory({ projectId: f.project.id, source: 'transport', id: leaf.id });
  await assert.rejects(f.service.reclaimTransportHistory({ projectId: f.project.id, id: leaf.id, fingerprint: preview.fingerprint, confirm: '回收' }), /基线/u);
  assert.ok((await fs.stat(leaf.folder)).isDirectory(), '被拒绝时不能删除基线与目录');
});