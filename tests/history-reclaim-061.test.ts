import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workspace } from '../src/main/workspace';
import { MaterialSyncService } from '../src/main/material-sync';

async function fixture() {
  const root = await fs.mkdtemp(path.resolve('.artifacts/history-reclaim-061-'));
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
    request: { projectId: project.id, id, fingerprint: preview.fingerprint },
    reclaim: (fingerprint: string) => service.reclaimHistory({ projectId: project.id, id, fingerprint, confirm: '回收' as const }),
    records: path.join(data, 'material-sync', `${project.id}-reclaims.json`) };
}

test('回收保留区历史：删除该目录、释放字节并留下回收记录，活动区与当前资料不受影响', async () => {
  const f = await fixture(), bytes = (await fs.readFile(path.join(f.folder, 'nested', '故事.txt'))).length;
  await f.service.retainHistory(f.request);
  const preview = await f.service.previewHistory({ projectId: f.project.id, source: 'local', id: f.id });
  const result = await f.service.reclaimHistory({ projectId: f.project.id, id: f.id, fingerprint: preview.fingerprint, confirm: '回收' });
  assert.deepEqual(result, { schemaVersion: 1, projectId: f.project.id, id: f.id, files: 1, bytes, reclaimedAt: result.reclaimedAt });
  await assert.rejects(fs.lstat(path.join(f.retained, f.id)), { code: 'ENOENT' });
  assert.equal((await f.service.history(f.project.id)).versions.length, 0);
  assert.equal((await f.service.capacity(f.project.id)).local.entries, 0);
  assert.equal(await fs.readFile(path.join(f.canonical, '当前.txt'), 'utf8'), '虚构当前内容');
  const records = JSON.parse(await fs.readFile(f.records, 'utf8')) as { id: string; bytes: number }[];
  assert.equal(records.length, 1); assert.equal(records[0]!.id, f.id); assert.equal(records[0]!.bytes, bytes);
});

test('活动区历史不能直接回收；指纹不符、确认字不对都拒绝且不删除', async () => {
  const f = await fixture();
  await assert.rejects(f.reclaim(f.preview.fingerprint), /活动区/u);
  assert.equal(await fs.readFile(path.join(f.folder, 'nested', '故事.txt'), 'utf8'), '虚构历史原始内容\r\n');
  await f.service.retainHistory(f.request);
  const preview = await f.service.previewHistory({ projectId: f.project.id, source: 'local', id: f.id });
  await assert.rejects(f.reclaim('0'.repeat(64)), /不一致|变化/u);
  await assert.rejects(async () => f.service.reclaimHistory({ projectId: f.project.id, id: f.id, fingerprint: preview.fingerprint } as never), /回收/u);
  assert.equal(await fs.readFile(path.join(f.retained, f.id, 'nested', '故事.txt'), 'utf8'), '虚构历史原始内容\r\n');
});

test('仍被其他版本当作父版本时拒绝回收；跨书拒绝', async () => {
  const f = await fixture();
  await f.service.retainHistory(f.request);
  const preview = await f.service.previewHistory({ projectId: f.project.id, source: 'local', id: f.id });
  const versions = path.join(f.book, '小说资料', '创作资料同步', '版本', randomUUID());
  await fs.mkdir(versions, { recursive: true });
  await fs.writeFile(path.join(versions, 'manifest.json'), JSON.stringify({ schemaVersion: 1, projectId: f.project.id,
    revisionId: path.basename(versions), createdAt: new Date().toISOString(), parents: [f.id], entries: [] }), 'utf8');
  await assert.rejects(f.service.reclaimHistory({ projectId: f.project.id, id: f.id, fingerprint: preview.fingerprint, confirm: '回收' }), /父版本/u);
  assert.equal(await fs.readFile(path.join(f.retained, f.id, 'nested', '故事.txt'), 'utf8'), '虚构历史原始内容\r\n');
  await assert.rejects(async () => f.service.reclaimHistory({ projectId: randomUUID(), id: f.id, fingerprint: preview.fingerprint, confirm: '回收' }), /未关联|小说/u);
});

test('包含硬链接的保留区历史拒绝回收，原件保留', async () => {
  const f = await fixture();
  await f.service.retainHistory(f.request);
  await fs.link(path.join(f.retained, f.id, 'nested', '故事.txt'), path.join(f.retained, f.id, 'nested', '硬链接.txt'));
  const preview = await f.service.previewHistory({ projectId: f.project.id, source: 'local', id: f.id });
  await assert.rejects(f.service.reclaimHistory({ projectId: f.project.id, id: f.id, fingerprint: preview.fingerprint, confirm: '回收' }), /硬链接/u);
  assert.equal(await fs.readFile(path.join(f.retained, f.id, 'nested', '故事.txt'), 'utf8'), '虚构历史原始内容\r\n');
});

test('保留区历史若是本机上次同步基线也不能回收', async t => {
  const f = await fixture();
  await f.service.retainHistory(f.request);
  const preview = await f.service.previewHistory({ projectId: f.project.id, source: 'local', id: f.id });
  const stateFile = path.join(f.data, 'material-sync', `${f.project.id}.json`);
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify({ schemaVersion: 1, projectId: f.project.id, enabled: true, base: {}, lastRevision: f.id, lastSyncedAt: new Date().toISOString() }), 'utf8');
  await assert.rejects(f.service.reclaimHistory({ projectId: f.project.id, id: f.id, fingerprint: preview.fingerprint, confirm: '回收' }), /基线/u);
  assert.ok((await fs.stat(path.join(f.retained, f.id))).isDirectory(), '被拒绝时不能删除');
});