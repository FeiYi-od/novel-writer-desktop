import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workspace } from '../src/main/workspace';
import { MaterialSyncService } from '../src/main/material-sync';
import { parseMaterialHistoryDag } from '../src/main/material-history-dag';

async function fillTo(directory: string, count: number) {
  await fs.mkdir(directory, { recursive: true });
  let size = (await fs.readdir(directory)).length;
  while (size < count) {
    const batch = Math.min(32, count - size);
    await Promise.all(Array.from({ length: batch }, () => fs.mkdir(path.join(directory, randomUUID()))));
    size += batch;
  }
  assert.equal((await fs.readdir(directory)).length, count);
}

test('保留1000与活动999时仍可同步至2000并完整导出；两根均满后下次同步拒绝', { timeout: 180000 }, async () => {
  const root = await fs.mkdtemp(path.resolve('.artifacts/material-retention-boundary-058-'));
  const book = path.join(root, '虚构星港'); await fs.mkdir(book);
  const dataA = path.join(root, 'A'), dataB = path.join(root, 'B');
  const materialsA = path.join(dataA, '创作资料'), materialsB = path.join(dataB, '创作资料');
  const a = new Workspace(dataA, materialsA), b = new Workspace(dataB, materialsB); await a.initialize(); await b.initialize();
  const project = await a.attach(book); await b.attach(book);
  const canonicalA = path.join(materialsA, project.id), canonicalB = path.join(materialsB, project.id);
  await fs.mkdir(canonicalA, { recursive: true }); await fs.mkdir(canonicalB, { recursive: true });
  const first = new MaterialSyncService(a, materialsA, dataA), second = new MaterialSyncService(b, materialsB, dataB);
  const active = path.join(materialsB, '同步历史', project.id), retained = path.join(materialsB, '同步历史保留', project.id);
  await fs.writeFile(path.join(canonicalA, '虚构设定.txt'), '初稿');
  await first.configure(project.id, true); await first.synchronize({ projectId: project.id }); await second.synchronize({ projectId: project.id });
  await fillTo(active, 999); await fillTo(retained, 1000);
  await fs.writeFile(path.join(canonicalA, '虚构设定.txt'), '第二版'); await first.synchronize({ projectId: project.id });
  await second.synchronize({ projectId: project.id });
  assert.equal(await fs.readFile(path.join(canonicalB, '虚构设定.txt'), 'utf8'), '第二版');
  assert.equal((await fs.readdir(active)).length, 1000); assert.equal((await fs.readdir(retained)).length, 1000);
  const history = await second.history(project.id);
  assert.equal(history.versions.filter(version => version.source === 'local').length, 2000, '两处所有历史必须可见');
  const preview = await second.previewHistoryDag(project.id);
  assert.equal(preview.localArchives, 2000, '完整预览不能漏掉保留历史');
  const archive = await second.archiveHistoryDag({ projectId: project.id, fingerprint: preview.fingerprint });
  const completion = path.join(archive.directory, '完成清单.json');
  const parsed = parseMaterialHistoryDag(await fs.readFile(archive.file), await fs.readFile(completion), project.id);
  assert.equal(parsed.manifest.local.length, 2000, '完整ZIP和完成清单都必须能读回2000份历史');
  await fs.writeFile(path.join(canonicalA, '虚构设定.txt'), '第三版'); await first.synchronize({ projectId: project.id });
  const statePath = path.join(dataB, 'material-sync', `${project.id}.json`), state = await fs.readFile(statePath);
  await assert.rejects(second.synchronize({ projectId: project.id }), /1000|容量|历史/u);
  assert.equal(await fs.readFile(path.join(canonicalB, '虚构设定.txt'), 'utf8'), '第二版');
  assert.deepEqual(await fs.readFile(statePath), state);
  assert.equal((await fs.readdir(active)).length, 1000); assert.equal((await fs.readdir(retained)).length, 1000);
});
