import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, MIGRATION_FILE, migrations, type Migration } from '../src/main/migrations';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-migrate-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

test('升级：首次运行执行全部步骤并写记录，重跑不重复执行', async t => {
  const root = await fixture(t);
  let runs = 0;
  const steps: Migration[] = [{ id: 'a', description: '一', run: async () => { runs++; } }, { id: 'b', description: '二', run: async () => { runs++; } }];
  const first = await runMigrations(root, steps);
  assert.deepEqual(first.applied, ['a', 'b']); assert.equal(runs, 2);
  assert.equal(first.state.applied.length, 2);
  const second = await runMigrations(root, steps);
  assert.deepEqual(second.applied, []); assert.equal(runs, 2, '已记录的步骤不得再次执行');
});

test('升级：失败步骤不写记录，下次启动从该步继续', async t => {
  const root = await fixture(t);
  let attempts = 0;
  const steps: Migration[] = [
    { id: 'ok', description: '成功', run: async () => {} },
    { id: 'bad', description: '失败', run: async () => { attempts++; if (attempts === 1) throw new Error('磁盘不可写'); } }
  ];
  await assert.rejects(runMigrations(root, steps), /磁盘不可写/u);
  const state = JSON.parse(await fs.readFile(path.join(root, MIGRATION_FILE), 'utf8')) as { applied: string[] };
  assert.deepEqual(state.applied, ['ok'], '只记录已完成的步骤');
  const retry = await runMigrations(root, steps);
  assert.deepEqual(retry.applied, ['bad']);
});

test('升级：损坏或未知版本的记录明确报错并保留原文件', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, MIGRATION_FILE), '{ broken', 'utf8');
  await assert.rejects(runMigrations(root, migrations), /损坏|保留/u);
  assert.equal(await fs.readFile(path.join(root, MIGRATION_FILE), 'utf8'), '{ broken', '损坏文件必须原样保留');
  await fs.writeFile(path.join(root, MIGRATION_FILE), JSON.stringify({ schemaVersion: 99, applied: [], updatedAt: '' }), 'utf8');
  await assert.rejects(runMigrations(root, migrations), /版本不受支持/u);
});

test('升级：内置步骤只创建本机数据目录，不触碰小说文件夹', async t => {
  const root = await fixture(t);
  const novel = path.join(root, '小说'); await fs.mkdir(novel);
  await fs.writeFile(path.join(novel, '第一章.docx'), 'fictional', 'utf8');
  const result = await runMigrations(root, migrations);
  assert.ok(result.applied.includes('create-layout'));
  for (const name of ['ui-drafts', 'detection', 'detection-usage', 'vector-index']) assert.ok(await fs.stat(path.join(root, name)).then(() => true).catch(() => false), name);
  assert.equal(await fs.readFile(path.join(novel, '第一章.docx'), 'utf8'), 'fictional', '升级不得改写小说文件');
});
