import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
async function compiler() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return null;
  const root = path.join(process.env.LOCALAPPDATA, 'electron-builder/Cache');
  for (const version of await fs.readdir(root).catch(() => [])) {
    if (!/^nsis-[\d.]+$/u.test(version)) continue;
    const base = path.join(root, version);
    for (const child of ['', ...await fs.readdir(base)]) {
      const exe = path.join(base, child, 'Bin/makensis.exe');
      if (await fs.access(exe).then(() => true, () => false)) return exe;
    }
  }
  return null;
}
const nsi = (value: string) => value.replace(/\$/gu, () => '$$').replace(/"/gu, () => '$\\"');
async function harness(executable: string, conflict: boolean) {
  const root = await fs.mkdtemp(path.resolve('.artifacts/installer-hook-035-'));
  const install = path.join(root, 'old-install'), data = path.join(root, 'profile'), id = randomUUID();
  const relative = `${id}/资料.txt`, source = path.join(install, '创作资料', relative);
  await fs.mkdir(path.dirname(source), { recursive: true }); await fs.writeFile(source, '旧版虚构原件');
  if (conflict) {
    const target = path.join(data, '创作资料', relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, '已有新版资料');
  }
  const marker = path.join(root, 'uninstall-may-proceed.txt'), output = path.join(root, 'guard.exe'), script = path.join(root, 'guard.nsi');
  const text = `Unicode true
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
Name "Isolated material guard test"
OutFile "${nsi(output)}"
InstallDir "${nsi(install)}"
!include LogicLib.nsh
!define INSTALL_REGISTRY_KEY "Software\\NovelWriterTests\\${randomUUID()}"
!define NOVEL_WRITER_UPGRADE_DATA "${nsi(data)}"
!include "${nsi(path.resolve('scripts/installer-materials.nsh'))}"
Section
  !insertmacro customCheckAppRunning
  FileOpen $0 "${nsi(marker)}" w
  FileWrite $0 "guard-passed"
  FileClose $0
SectionEnd
`;
  await fs.writeFile(script, '\uFEFF' + text);
  await run(executable, ['/V2', script], { windowsHide: true, timeout: 30000 });
  let code = 0;
  try { await run(output, ['/S'], { windowsHide: true, timeout: 60000 }); }
  catch (error) { code = Number((error as { code: number }).code); assert.ok(Number.isFinite(code), 'guard must exit, not time out'); }
  assert.equal(await fs.readFile(source, 'utf8'), '旧版虚构原件');
  if (conflict) {
    assert.notEqual(code, 0); await assert.rejects(fs.access(marker));
    assert.equal(await fs.readFile(path.join(data, '创作资料', relative), 'utf8'), '已有新版资料');
  } else {
    assert.equal(code, 0); assert.equal(await fs.readFile(marker, 'utf8'), 'guard-passed');
    assert.equal(await fs.readFile(path.join(data, '创作资料', relative), 'utf8'), '旧版虚构原件');
  }
}
test('actual NSIS pre-uninstall hook preserves legacy materials before permitting removal', async t => {
  const exe = await compiler(); if (!exe) { t.skip('Windows cached NSIS compiler required'); return; }
  await harness(exe, false);
});
test('actual NSIS pre-uninstall hook aborts on conflicting stable materials and preserves both sides', async t => {
  const exe = await compiler(); if (!exe) { t.skip('Windows cached NSIS compiler required'); return; }
  await harness(exe, true);
});
