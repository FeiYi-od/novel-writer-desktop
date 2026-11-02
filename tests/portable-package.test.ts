import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import JSZip from 'jszip';

const script = path.resolve('scripts/make-portable.ps1');
async function fixture() {
  const root = path.resolve('.artifacts', `portable-guard-${randomUUID()}`);
  const local = path.join(root, 'local');
  const build = path.join(local, 'NovelWriterBuild', 'win-unpacked');
  await fs.mkdir(path.join(build, 'resources'), { recursive: true });
  await fs.writeFile(path.join(build, '小说编写器.exe'), 'fixture executable, never launched');
  await fs.writeFile(path.join(build, 'resources', 'app.asar'), 'fixture packaged archive');
  await fs.writeFile(path.join(build, 'resources', 'app-icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
  return { root, local, build };
}
function run(root: string, local: string, output: string, zip?: string) {
  return spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Output', output, ...(zip ? ['-Zip', zip] : [])], {
    cwd: root, env: { ...process.env, LOCALAPPDATA: local }, encoding: 'utf8', timeout: 30000, windowsHide: true
  });
}
const windowsOnly = { skip: process.platform !== 'win32' };

test('portable packaging refuses existing output and preserves author materials', windowsOnly, async () => {
  const { root, local } = await fixture();
  const output = path.join(root, '旧便携版');
  const original = path.join(output, '创作资料', 'author.md');
  await fs.mkdir(path.dirname(original), { recursive: true });
  const bytes = Buffer.from('不可删除的既有资料。\n');
  await fs.writeFile(original, bytes);
  const result = run(root, local, output, path.join(root, 'new.zip'));
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout + result.stderr, /already exists/u);
  assert.deepEqual(await fs.readFile(original), bytes);
  await assert.rejects(fs.stat(path.join(root, 'new.zip')), { code: 'ENOENT' });
});

test('portable packaging refuses an existing ZIP before creating an output directory', windowsOnly, async () => {
  const { root, local } = await fixture();
  const archive = path.join(root, 'existing.zip');
  const original = Buffer.from('existing archive');
  await fs.writeFile(archive, original);
  const output = path.join(root, 'new-output');
  const result = run(root, local, output, archive);
  assert.notEqual(result.status, 0);
  assert.deepEqual(await fs.readFile(archive), original);
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
});

test('portable packaging refuses source overlap and runtime data in the packaged directory', windowsOnly, async () => {
  const { root, local, build } = await fixture();
  const executable = await fs.readFile(path.join(build, '小说编写器.exe'));
  const overlap = run(root, local, path.join(build, 'nested'), path.join(root, 'overlap.zip'));
  assert.notEqual(overlap.status, 0);
  assert.match(overlap.stdout + overlap.stderr, /must not overlap/u);
  assert.deepEqual(await fs.readFile(path.join(build, '小说编写器.exe')), executable);
  await fs.mkdir(path.join(build, '创作资料'));
  await fs.writeFile(path.join(build, '创作资料', 'private.md'), 'private fixture');
  const result = run(root, local, path.join(root, 'clean-output'), path.join(root, 'clean.zip'));
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /Unexpected packaged directory/u);
  await assert.rejects(fs.stat(path.join(root, 'clean-output')), { code: 'ENOENT' });
});

test('portable packaging creates a fresh Unicode output and a versioned ZIP without deleting its source', windowsOnly, async () => {
  const { root, local, build } = await fixture();
  const output = path.join(root, "全新便携版 作者's copy");
  const result = run(root, local, output);
  assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error ?? ''));
  assert.equal(await fs.readFile(path.join(build, 'resources', 'app.asar'), 'utf8'), 'fixture packaged archive');
  assert.equal(await fs.readFile(path.join(output, 'resources', 'app.asar'), 'utf8'), 'fixture packaged archive');
  const icon = await fs.readFile(path.join(build, 'resources', 'app-icon.png'));
  assert.deepEqual(await fs.readFile(path.join(output, 'resources', 'app-icon.png')), icon);
  assert.equal(await fs.readFile(path.join(output, 'NovelWriter.exe'), 'utf8'), 'fixture executable, never launched');
  const version = JSON.parse(await fs.readFile('package.json', 'utf8')).version as string;
  const archive = await JSZip.loadAsync(await fs.readFile(path.join(root, 'release', `NovelWriter-${version}-portable.zip`)));
  assert.ok(archive.file('NovelWriter.exe'));
  assert.deepEqual(await archive.file('resources/app-icon.png')!.async('nodebuffer'), icon);
  assert.match(await archive.file('使用说明.txt')!.async('string'), /%APPDATA%\\novel-writer/u);
  assert.equal(Object.keys(archive.files).some(name => /创作资料|private\.md/u.test(name)), false);
});

test('portable packaging refuses unknown resources before creating output', windowsOnly, async () => {
  const { root, local, build } = await fixture();
  await fs.writeFile(path.join(build, 'resources', 'unexpected-user-data.json'), 'private fixture');
  const output = path.join(root, 'clean-output');
  const result = run(root, local, output, path.join(root, 'clean.zip'));
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /Unexpected packaged resource/u);
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
});

test('portable packaging refuses a junction ancestor and leaves the target untouched', windowsOnly, async () => {
  const { root, local } = await fixture();
  const real = path.join(root, 'real');
  const alias = path.join(root, 'alias');
  await fs.mkdir(real);
  await fs.writeFile(path.join(real, 'keep.txt'), 'keep fixture');
  await fs.symlink(real, alias, 'junction');
  const result = run(root, local, path.join(alias, 'new-output'), path.join(root, 'new.zip'));
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /Linked portable paths/u);
  assert.equal(await fs.readFile(path.join(real, 'keep.txt'), 'utf8'), 'keep fixture');
  await assert.rejects(fs.stat(path.join(real, 'new-output')), { code: 'ENOENT' });
});
