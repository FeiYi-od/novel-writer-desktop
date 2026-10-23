import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { TimelineStore } from '../src/main/timeline';
import { RelationStore } from '../src/main/relations';
import { CharacterStateStore } from '../src/main/character-states';
import { PromptLibraryStore } from '../src/main/prompt-library';
import { BlueprintStore } from '../src/main/blueprint';
import { StyleHistoryStore } from '../src/main/style-history';
import { ProjectRecord } from '../src/main/project-record';
import { z } from 'zod';
const schema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), updatedAt: z.string(), entries: z.array(z.string()) });
async function fixture() {
  const root = await fs.mkdtemp(path.resolve('.artifacts/records-034-'));
  const workspace = new Workspace(path.join(root, 'local'));
  await workspace.initialize();
  const a = path.join(root, 'A'), b = path.join(root, 'B'); await fs.mkdir(a); await fs.mkdir(b);
  const project = await workspace.attach(a), other = await workspace.attach(b);
  return { root, workspace, project, other, record: new ProjectRecord(workspace, '测试资料', schema) };
}
test('six stores bind full document identity and keep same-name projects separate', async () => {
  const f = await fixture();
  f.project.name = f.other.name = '相同书名';
  const stores = [new TimelineStore(f.workspace), new RelationStore(f.workspace), new CharacterStateStore(f.workspace), new PromptLibraryStore(f.workspace), new BlueprintStore(f.workspace)];
  const labels = ['时间线', '人物关系', '人物状态', '提示词库', '蓝图'];
  for (const [i, store] of stores.entries()) {
    const a = await store.save(f.project.id, [], ''), b = await store.save(f.other.id, [], '');
    assert.notEqual(a.hash, b.hash);
    const file = path.join(f.project.root, '小说资料', `${labels[i]}.json`);
    const raw = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, raw.replace(f.project.id, f.other.id));
    await assert.rejects(store.read(f.project.id), /归属/);
    assert.equal((await store.read(f.other.id)).hash, b.hash);
    await fs.writeFile(file, raw);
  }
  const styles = new StyleHistoryStore(f.workspace);
  const a = await styles.ensure(f.project.id, '', '风格', '短段落');
  await styles.ensure(f.other.id, '', '风格', '长段落');
  assert.equal((await styles.read(f.other.id)).entries[0].current.rules, '长段落');
  assert.equal((await styles.ensure(f.project.id, a.hash, '风格', '无变化')).hash, a.hash);
});
test('legacy migration copies only matching identity, preserves bytes, and rejects unknown schema', async () => {
  const f = await fixture(), directory = path.join(f.root, '创作资料'); await fs.mkdir(directory);
  const file = path.join(directory, `测试资料-${f.project.name}.json`);
  const raw = JSON.stringify({ schemaVersion: 1, projectId: f.project.id, updatedAt: '', entries: ['旧版'], annotation: '保留' });
  await fs.writeFile(file, raw);
  const migrated = await f.record.read(f.project.id);
  assert.deepEqual(migrated.value?.entries, ['旧版']);
  assert.equal(await fs.readFile(file, 'utf8'), raw);
  assert.equal(await fs.readFile(path.join(f.project.root, '小说资料/测试资料.json'), 'utf8'), raw);
  const wrong = path.join(directory, `测试资料-${f.other.name}.json`); await fs.writeFile(wrong, raw);
  await assert.rejects(f.record.read(f.other.id), /归属/);
  await fs.writeFile(wrong, raw.replace('"schemaVersion":1', '"schemaVersion":2'));
  await assert.rejects(f.record.read(f.other.id), /版本/);
  const next = await f.record.save(f.project.id, { ...migrated.value!, entries: ['新版'] }, migrated.hash);
  assert.equal(JSON.parse(next.raw!).annotation, '保留');
});
test('full raw bytes include IDs, timestamps and annotations; stale saves preserve external writes', async () => {
  const f = await fixture();
  const first = await f.record.save(f.project.id, { schemaVersion: 1, projectId: f.project.id, updatedAt: '', entries: ['初稿'] }, '');
  const file = path.join(f.project.root, '小说资料/测试资料.json');
  const changed = JSON.stringify({ ...JSON.parse(first.raw!), annotation: '外部版本' }); await fs.writeFile(file, changed);
  await assert.rejects(f.record.save(f.project.id, { ...first.value!, entries: ['错误覆盖'] }, first.hash), /修改/);
  assert.equal(await fs.readFile(file, 'utf8'), changed);
  const latest = await f.record.read(f.project.id); assert.notEqual(latest.hash, first.hash);
  await f.record.save(f.project.id, { ...latest.value!, entries: ['修订'] }, latest.hash);
  const history = path.join(f.project.root, '小说资料/测试资料历史');
  assert.ok((await fs.readdir(history)).length);
  assert.equal(await fs.readFile(path.join(history, (await fs.readdir(history))[0]), 'utf8'), changed);
});
test('record file/directory links are rejected and concurrent first writes cannot overwrite each other', async () => {
  const f = await fixture();
  const record = { schemaVersion: 1 as const, projectId: f.project.id, updatedAt: '', entries: ['一'] };
  const outcomes = await Promise.allSettled([f.record.save(f.project.id, record, ''), new ProjectRecord(f.workspace, '测试资料', schema).save(f.project.id, { ...record, entries: ['二'] }, '')]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  const meta = path.join(f.other.root, '小说资料');
  // Workspace has created only project.json; move this known fixture directory intact.
  await fs.rename(meta, path.join(f.other.root, 'old-meta'));
  await fs.symlink(outside, meta, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.record.read(f.other.id), /链接|越界/);
  assert.deepEqual(await fs.readdir(outside), []);
});
test('valid UTF-8 BOM remains in the source hash; invalid UTF-8 cannot be silently re-encoded', async () => {
  const f = await fixture(), value = { schemaVersion: 1 as const, projectId: f.project.id, updatedAt: '', entries: ['x'] };
  const first = await f.record.save(f.project.id, value, ''), file = path.join(f.project.root, '小说资料/测试资料.json');
  await fs.writeFile(file, '\uFEFF' + first.raw);
  const bom = await f.record.read(f.project.id); assert.notEqual(bom.hash, first.hash); assert.deepEqual(bom.value, first.value);
  const invalid = Buffer.concat([Buffer.from(JSON.stringify(value).slice(0, -1)), Buffer.from([0xff]), Buffer.from('}')]); await fs.writeFile(file, invalid);
  await assert.rejects(f.record.read(f.project.id), /UTF-8/); assert.deepEqual(await fs.readFile(file), invalid);
});
