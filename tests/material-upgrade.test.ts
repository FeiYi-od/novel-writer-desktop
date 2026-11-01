import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { WAIT_LIMIT } from './wait';

const script = path.resolve('scripts/protect-upgrade-materials.ps1');
const windows = { skip: process.platform !== 'win32' };
type GuardResult = { code: number | null; out: string; error: string; result?: { schemaVersion: number; status: string; files: number; backupDirectory?: string } };

async function fixture() {
  const root = path.resolve('.artifacts', 'material-upgrade-tests', randomUUID());
  const install = path.join(root, '旧应用安装');
  const userData = path.join(root, '独立稳定数据');
  const source = path.join(install, '创作资料');
  const stable = path.join(userData, '创作资料');
  await fs.mkdir(source, { recursive: true });
  return { root, install, userData, source, stable };
}

async function guard(f: { install: string; userData: string }, allowProcessId?: number): Promise<GuardResult> {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-SourceInstall', f.install, '-UserData', f.userData];
  if (allowProcessId !== undefined) args.push('-AllowProcessId', String(allowProcessId));
  return await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', error = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', text => { out += text; });
    child.stderr.on('data', text => { error += text; });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('upgrade guard timed out')); }, 45_000);
    child.on('error', err => { clearTimeout(timeout); reject(err); });
    child.on('close', code => {
      clearTimeout(timeout);
      let result: GuardResult['result'];
      if (code === 0) {
        try { result = JSON.parse(out.trim()); }
        catch { reject(new Error(`guard produced invalid JSON: ${out.slice(0, 500)} / ${error.slice(0, 500)}`)); return; }
      }
      resolve({ code, out, error, result });
    });
  });
}

async function sample(source: string) {
  const id = '3cc66422-3045-4197-9e98-7b9392445910';
  await fs.mkdir(path.join(source, id, '人物原图'), { recursive: true });
  await fs.mkdir(path.join(source, '空目录'), { recursive: true });
  await fs.writeFile(path.join(source, id, '世界观.md'), '虚构星港\n世界观原件\n');
  await fs.writeFile(path.join(source, id, '人物原图', '原图.png'), Buffer.from([0, 1, 2, 255, 0, 128]));
  return id;
}

async function tree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(current: string, relative: string) {
    for (const child of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, child.name), name = relative ? `${relative}/${child.name}` : child.name;
      assert.ok(!child.isSymbolicLink(), 'test tree must not follow links');
      if (child.isDirectory()) { result[`${name}/`] = 'directory'; await visit(target, name); }
      else result[name] = createHash('sha256').update(await fs.readFile(target)).digest('hex');
    }
  }
  await visit(root, ''); return result;
}

async function backups(userData: string) {
  try { return (await fs.readdir(path.join(userData, 'material-upgrade-backups'))).filter(name => /^[0-9a-f-]{36}$/i.test(name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

test('升级保护：脚本使用UTF-8 BOM且缺失/无普通文件的源安全跳过', windows, async t => {
  assert.deepEqual((await fs.readFile(script)).subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  for (const missing of [false, true]) await t.test(missing ? 'missing installation root' : 'empty materials', async () => {
    const f = await fixture();
    const r = await guard({ ...f, install: missing ? path.join(f.root, '未安装') : f.install });
    assert.equal(r.code, 0, r.error); assert.equal(r.result?.status, 'skipped'); assert.equal(r.result?.files, 0);
    await assert.rejects(fs.stat(f.userData), { code: 'ENOENT' });
  });
});

test('升级保护：完整导入、原件原字节保留、目录/二进制/快照清单逐项校验', windows, async () => {
  const f = await fixture(); await sample(f.source); const before = await tree(f.source);
  const r = await guard(f);
  assert.equal(r.code, 0, r.error); assert.equal(r.result?.status, 'imported'); assert.equal(r.result?.files, 2);
  assert.deepEqual(await tree(f.source), before); assert.deepEqual(await tree(f.stable), before);
  const backup = r.result!.backupDirectory!;
  assert.ok(backup.startsWith(path.join(f.userData, 'material-upgrade-backups') + path.sep));
  assert.deepEqual(await tree(path.join(backup, 'files')), before);
  const manifest = JSON.parse(await fs.readFile(path.join(backup, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.sourceInstall, f.install);
  assert.equal(manifest.entries.length, 2); assert.ok(manifest.directories.includes('空目录'));
  for (const entry of manifest.entries) {
    const bytes = await fs.readFile(path.join(backup, 'files', entry.path));
    assert.equal(entry.bytes, bytes.length); assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
  const receipt = JSON.parse(await fs.readFile(path.join(f.userData, 'material-upgrade-state.json'), 'utf8'));
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.files, 2); assert.equal(receipt.sourceFingerprint, manifest.sourceFingerprint);
  assert.equal(receipt.backupDirectory, backup);
});

test('升级保护：重复启动允许稳定资料继续编辑，不重复备份或覆写', windows, async () => {
  const f = await fixture(), id = await sample(f.source);
  assert.equal((await guard(f)).code, 0);
  const receipt = await fs.readFile(path.join(f.userData, 'material-upgrade-state.json'));
  await fs.writeFile(path.join(f.stable, id, '世界观.md'), '作者在新版本确认的世界观');
  await fs.writeFile(path.join(f.stable, '新增资料.md'), '作者新增');
  const edited = await tree(f.stable), old = await tree(f.source), count = (await backups(f.userData)).length;
  const r = await guard(f);
  assert.equal(r.code, 0, r.error); assert.equal(r.result?.status, 'preserved');
  assert.deepEqual(await tree(f.stable), edited); assert.deepEqual(await tree(f.source), old);
  assert.deepEqual(await fs.readFile(path.join(f.userData, 'material-upgrade-state.json')), receipt);
  assert.equal((await backups(f.userData)).length, count);
});

test('升级保护：旧源在已迁移后新增/修改会留新备份并报冲突，不覆盖作者新资料', windows, async () => {
  const f = await fixture(), id = await sample(f.source); assert.equal((await guard(f)).code, 0);
  await fs.writeFile(path.join(f.stable, id, '世界观.md'), '新应用的确认版本');
  const stableBefore = await tree(f.stable), receiptBefore = await fs.readFile(path.join(f.userData, 'material-upgrade-state.json'));
  await fs.writeFile(path.join(f.source, id, '世界观.md'), '旧应用后来另写的一份');
  await fs.writeFile(path.join(f.source, id, '新增.md'), '旧版本新增');
  const changed = await tree(f.source), r = await guard(f);
  assert.equal(r.code, 1); assert.match(r.error, /UPGRADE_CONFLICT/);
  assert.deepEqual(await tree(f.stable), stableBefore); assert.deepEqual(await tree(f.source), changed);
  assert.deepEqual(await fs.readFile(path.join(f.userData, 'material-upgrade-state.json')), receiptBefore);
  const versions = await backups(f.userData); assert.equal(versions.length, 2);
  assert.ok((await Promise.all(versions.map(async version => JSON.stringify(await tree(path.join(f.userData, 'material-upgrade-backups', version, 'files')))))) .includes(JSON.stringify(changed)));
});

test('升级保护：已有目标不同时两侧与备份保留，相同时记录迁移凭据', windows, async t => {
  for (const same of [false, true]) await t.test(same ? 'identical destination' : 'different destination', async () => {
    const f = await fixture(); await sample(f.source);
    if (same) await fs.cp(f.source, f.stable, { recursive: true });
    else { await fs.mkdir(f.stable, { recursive: true }); await fs.writeFile(path.join(f.stable, '独立原件.md'), '不能覆盖'); }
    const before = await tree(f.stable), original = await tree(f.source), r = await guard(f);
    assert.equal(r.code, same ? 0 : 1, r.error);
    if (same) assert.equal(r.result?.status, 'preserved'); else assert.match(r.error, /UPGRADE_CONFLICT/);
    assert.deepEqual(await tree(f.stable), before); assert.deepEqual(await tree(f.source), original);
    const versions = await backups(f.userData); assert.equal(versions.length, 1);
    assert.deepEqual(await tree(path.join(f.userData, 'material-upgrade-backups', versions[0], 'files')), original);
    if (!same) await assert.rejects(fs.stat(path.join(f.userData, 'material-upgrade-state.json')), { code: 'ENOENT' });
  });
});

test('升级保护：未知版本/损坏/空值凭据拒绝，不能当作未迁移', windows, async t => {
  for (const receipt of ['null', '{broken', JSON.stringify({ schemaVersion: 2, sourceInstall: 'C:\\invalid', sourceFingerprint: 'a'.repeat(64), files: 1 }), JSON.stringify({ schemaVersion: '1', sourceInstall: 'C:\\invalid', sourceFingerprint: 'a'.repeat(64), files: 1 })]) {
    await t.test(receipt.slice(0, 24), async () => {
      const f = await fixture(); await sample(f.source); await fs.mkdir(f.userData);
      const record = path.join(f.userData, 'material-upgrade-state.json'); await fs.writeFile(record, receipt);
      const r = await guard(f); assert.equal(r.code, 1); assert.match(r.error, /UPGRADE_RECEIPT/);
      assert.equal(await fs.readFile(record, 'utf8'), receipt); await assert.rejects(fs.stat(f.stable), { code: 'ENOENT' });
      assert.equal((await backups(f.userData)).length, 0);
    });
  }
});

test('升级保护：源资料/子目录/稳定目录/数据根的junction全部拒绝且不写外侧', windows, async t => {
  for (const kind of ['source', 'nested', 'stable', 'userData'] as const) await t.test(kind, async () => {
    const f = await fixture(), outside = path.join(f.root, '外侧原件'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, '原件.md'), '外侧受保护');
    if (kind === 'source') { await fs.rmdir(f.source); await fs.symlink(outside, f.source, 'junction'); }
    else {
      await sample(f.source);
      if (kind === 'nested') await fs.symlink(outside, path.join(f.source, '链接'), 'junction');
      if (kind === 'userData') await fs.symlink(outside, f.userData, 'junction');
      if (kind === 'stable') { await fs.mkdir(f.userData); await fs.symlink(outside, f.stable, 'junction'); }
    }
    const before = await tree(outside), r = await guard(f);
    assert.equal(r.code, 1); assert.match(r.error, /UPGRADE_LINK/); assert.deepEqual(await tree(outside), before);
  });
});

test('升级保护：升级凭据文件链接和源/数据路径重叠均拒绝', windows, async t => {
  await t.test('overlapping paths', async () => {
    const f = await fixture(); await sample(f.source);
    const r = await guard({ install: f.install, userData: path.join(f.install, '数据') });
    assert.equal(r.code, 1); assert.match(r.error, /UPGRADE_PATH/);
  });
  await t.test('receipt directory junction', async () => {
    const f = await fixture(); await sample(f.source); await fs.mkdir(f.userData);
    await fs.symlink(f.source, path.join(f.userData, 'material-upgrade-state.json'), 'junction');
    const r = await guard(f); assert.equal(r.code, 1); assert.match(r.error, /UPGRADE_LINK/);
    assert.equal((await backups(f.userData)).length, 0);
  });
});

test('升级保护：超限普通文件拒绝，原件与目标不变', windows, async () => {
  const f = await fixture(), target = path.join(f.source, '过大资料.bin');
  const file = await fs.open(target, 'wx'); await file.truncate(64 * 1024 * 1024 + 1); await file.close();
  const r = await guard(f); assert.equal(r.code, 1); assert.match(r.error, /UPGRADE_LIMIT/);
  assert.equal((await fs.stat(target)).size, 64 * 1024 * 1024 + 1);
  await assert.rejects(fs.stat(f.stable), { code: 'ENOENT' });
});

async function runningFakeApp(t: TestContext, install: string, name = '小说编写器.exe') {
  const exe = path.join(install, name);
  await fs.copyFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'ping.exe'), exe);
  const child = spawn(exe, ['-t', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  t.after(async () => {
    if (child.exitCode !== null) return;
    const done = new Promise<void>(resolve => child.once('close', () => resolve()));
    child.kill(); await done;
  });
  return child;
}

test('升级保护：源exe运行时即使资料缺失也阻止安装，精确PID豁免只允许自身', windows, async t => {
  const f = await fixture(); await fs.rmdir(f.source);
  const app = await runningFakeApp(t, f.install);
  const blocked = await guard(f); assert.equal(blocked.code, 1); assert.match(blocked.error, /UPGRADE_PROCESS/);
  const allowed = await guard(f, app.pid); assert.equal(allowed.code, 0, allowed.error); assert.equal(allowed.result?.status, 'skipped');
  const invalid = await guard(f, process.pid); assert.equal(invalid.code, 1); assert.match(invalid.error, /UPGRADE_PROCESS/);
});

test('升级保护：不同安装根的同名exe不阻挡，不能按进程名字全局处理', windows, async t => {
  const f = await fixture(), other = path.join(f.root, '另一安装根'); await fs.mkdir(other);
  await runningFakeApp(t, other); await sample(f.source);
  const r = await guard(f); assert.equal(r.code, 0, r.error); assert.equal(r.result?.status, 'imported');
});

test('升级保护：便携版NovelWriter.exe同样按完整路径阻挡与豁免', windows, async t => {
  const f = await fixture(); await sample(f.source);
  const app = await runningFakeApp(t, f.install, 'NovelWriter.exe');
  const blocked = await guard(f); assert.equal(blocked.code, 1); assert.match(blocked.error, /UPGRADE_PROCESS/);
  const allowed = await guard(f, app.pid); assert.equal(allowed.code, 0, allowed.error); assert.equal(allowed.result?.status, 'imported');
});

test('升级保护：复制中源目录新增文件会中止，不将不完整快照导入稳定目录', windows, async () => {
  const f = await fixture();
  for (let index = 0; index < 100; index++) await fs.writeFile(path.join(f.source, `虚构资料-${String(index).padStart(3, '0')}.md`), '仅用于复制时变更检测\n'.repeat(100));
  let completed = false;
  const pending = guard(f).finally(() => { completed = true; });
  const deadline = Date.now() + WAIT_LIMIT;
  let changed = false;
  while (!completed && Date.now() < deadline) {
    const versions = await backups(f.userData);
    if (versions.length) {
      // Observe the real backup directory, without a production-only test hook.
      const files = path.join(f.userData, 'material-upgrade-backups', versions[0], 'files');
      try {
        if ((await fs.readdir(files)).length > 0) {
          await fs.writeFile(path.join(f.source, '复制开始后新增.md'), '后来新增的原件必须保留'); changed = true; break;
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const r = await pending;
  assert.ok(changed, 'must observe a real in-progress copy');
  assert.equal(r.code, 1); assert.match(r.error, /UPGRADE_CHANGED/);
  assert.equal(await fs.readFile(path.join(f.source, '复制开始后新增.md'), 'utf8'), '后来新增的原件必须保留');
  await assert.rejects(fs.stat(f.stable), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.userData, 'material-upgrade-state.json')), { code: 'ENOENT' });
  const versions = await backups(f.userData); assert.equal(versions.length, 1);
  await assert.rejects(fs.stat(path.join(f.userData, 'material-upgrade-backups', versions[0], 'manifest.json')), { code: 'ENOENT' });
});
