import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSyncState } from '../src/core/sync-status';
import { detectPathLocation, driveOf, parseDriveType, shareNameOf } from '../src/main/drive-type';

test('盘符类型解析：Remote 认成网络盘，Fixed 才是本地', () => {
  assert.equal(parseDriveType('H: - Fixed Drive'), 'fixed');
  assert.equal(parseDriveType('Z: - Remote Drive'), 'remote');
  assert.equal(parseDriveType('Z: - 网络驱动器'), 'remote');
  assert.equal(parseDriveType('D: - Removable Drive'), 'removable');
  assert.equal(parseDriveType('E: - CD-ROM Drive'), 'cdrom');
  assert.equal(parseDriveType('???'), 'unknown');
});

test('位置判定：UNC 直接确定；映射盘要问 fsutil；问了失败就 unknown', async () => {
  assert.equal(await detectPathLocation('\\\\192.0.2.1\\小说'), 'unc');
  const remote = await detectPathLocation('Z:\\小说编辑器', async () => 'Z: - Remote Drive');
  assert.equal(remote, 'network', '映射盘应识别为网络盘');
  const local = await detectPathLocation('H:\\小说编辑器', async () => 'H: - Fixed Drive');
  assert.equal(local, 'local', '本地固定盘应识别为本地');
  const failed = await detectPathLocation('Y:\\x', async () => { throw new Error('fsutil 不可用'); });
  assert.equal(failed, 'unknown');
  const cdrom = await detectPathLocation('E:\\x', async () => 'E: - CD-ROM Drive');
  assert.equal(cdrom, 'unknown', '光驱不能当成本地写作目录');
  assert.equal(driveOf('h:\\小说'), 'H:');
  assert.equal(driveOf('\\\\nas\\share'), null);
  assert.equal(shareNameOf('\\\\192.0.2.1\\小说编辑器\\甲'), '192.0.2.1\\小说编辑器');
});

test('同步状态：映射盘按网络目录措辞，仍不自称已同步', () => {
  const state = describeSyncState({ location: 'network', saved: true });
  assert.equal(state.level, 'unsynced');
  assert.match(state.text, /网络盘/u);
  assert.match(state.text, /无法确认/u);
  assert.doesNotMatch(state.text, /已同步/u);
});
