import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workspace } from '../src/main/workspace';
import { MaterialSyncService } from '../src/main/material-sync';

async function fixture() {
  const root = await fs.mkdtemp(path.resolve('.artifacts/material-sync-read-race-047-'));
  const data = path.join(root, 'profile'), materials = path.join(data, '创作资料'), book = path.join(root, '虚构小说');
  await fs.mkdir(book);
  const workspace = new Workspace(data, materials); await workspace.initialize();
  const project = await workspace.attach(book);
  const canonical = path.join(materials, project.id); await fs.mkdir(canonical, { recursive: true });
  const local = path.join(materials, '同步历史', project.id, randomUUID());
  await fs.mkdir(path.join(local, '人物'), { recursive: true });
  const source = path.join(local, '人物', '虚构历史.txt');
  const before = Buffer.alloc(128, 0x41), after = Buffer.alloc(128, 0x42);
  await fs.writeFile(source, before);
  const service = new MaterialSyncService(workspace, materials, data);
  return { root, data, materials, book, project, canonical, local, source, before, after, service,
    output: path.join(book, '小说资料', '完整历史归档') };
}

/** Change this fictional nested file between readRegular's final handle.stat()
 * and its subsequent lstat(path), keeping the same inode and byte length. */
function injectAfterRead(t: TestContext, file: string, replacement: Buffer) {
  const mutable = fs as unknown as { lstat: (...args: any[]) => Promise<any> };
  const original = mutable.lstat.bind(fs); let hits = 0, injected = false;
  t.mock.method(mutable, 'lstat', async (...args: any[]) => {
    if (typeof args[0] === 'string' && path.resolve(args[0]) === path.resolve(file) && ++hits === 3) {
      const before = await original(...args);
      await fs.writeFile(file, replacement);
      // Ensure a distinct timestamp even on filesystems with coarse clock resolution.
      const distinct = new Date(before.mtimeMs + 120_000); await fs.utimes(file, distinct, distinct);
      const after = await original(...args);
      assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
      assert.equal(after.size, before.size); assert.notEqual(after.mtimeMs, before.mtimeMs);
      injected = true;
    }
    return original(...args);
  });
  return () => ({ injected, hits });
}

test('DAG preview rejects a same-inode edit between the final handle stat and path lstat', async t => {
  const f = await fixture(); const inspect = injectAfterRead(t, f.source, f.after);
  let error: unknown;
  try { await f.service.previewHistoryDag(f.project.id); } catch (value) { error = value; }
  const evidence = inspect(); assert.equal(evidence.injected, true, 'Mock must intercept the actual service read');
  assert.equal(evidence.hits, 3); assert.deepEqual(await fs.readFile(f.source), f.after);
  assert.ok(error, 'A changed source must not be returned as a complete preview');
  assert.match(String(error), /变化|历史/u);
  await assert.rejects(fs.access(f.output));
});

test('the final DAG source check rejects that edit without publishing a completion record', async t => {
  const f = await fixture(), preview = await f.service.previewHistoryDag(f.project.id);
  const internal = f.service as unknown as {
    assertHistoryDagUnchanged: (context: unknown) => Promise<void>;
    checkDagArchiveTarget: (...args: unknown[]) => Promise<void>;
  };
  const checkSource = internal.assertHistoryDagUnchanged.bind(internal), checkTarget = internal.checkDagArchiveTarget.bind(internal);
  let targetChecks = 0, inspect: (() => { injected: boolean; hits: number }) | undefined;
  internal.checkDagArchiveTarget = async (...args) => { await checkTarget(...args); targetChecks++; };
  internal.assertHistoryDagUnchanged = async context => {
    if (targetChecks === 1 && !inspect) inspect = injectAfterRead(t, f.source, f.after);
    return checkSource(context);
  };
  let error: unknown;
  try { await f.service.archiveHistoryDag({ projectId: f.project.id, fingerprint: preview.fingerprint }); } catch (value) { error = value; }
  assert.ok(inspect, 'Final source inspection must run after the first target check');
  const evidence = inspect!(); assert.equal(evidence.injected, true, 'Mock must intercept the final source file read');
  assert.equal(evidence.hits, 3); assert.deepEqual(await fs.readFile(f.source), f.after);
  const folders = await fs.readdir(f.output); assert.equal(folders.length, 1);
  await assert.rejects(fs.access(path.join(f.output, folders[0]!, '完成清单.json')));
  assert.ok(error, 'A changed source must prevent completion'); assert.match(String(error), /变化|历史/u);
});
