import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assignVolumeChapters, moveVolumes, removeVolumes } from '../src/core/volume-management';
import { Workspace } from '../src/main/workspace';
import { LibraryStore } from '../src/main/library';
import { textDocument } from '../src/main/text-import';
import type { BookDetails } from '../src/shared/contracts';

function book(): BookDetails {
  return { schemaVersion: 1, projectId: randomUUID(), title: '虚构分集作品', introduction: '', cover: '', sources: [], styles: [], activeStyleId: '', volumes: ['甲', '乙', '丙', '丁', '戊'].map((title, i) => ({ id: randomUUID(), title, introduction: `引言${title}`, cover: '', chapters: [`目录${i}/同名.docx`] })) };
}
const titles = (value: BookDetails) => value.volumes.map(v => v.title);

test('分集单项向前和向后移动，只改目录顺序并保留全部属性', () => {
  const value = book(), raw = JSON.stringify(value), selected = value.volumes[2].id;
  const up = moveVolumes(value, value.projectId, [selected], 'up'); assert.deepEqual(titles(up), ['甲', '丙', '乙', '丁', '戊']);
  assert.deepEqual(moveVolumes(up, value.projectId, [selected], 'down'), value); assert.equal(JSON.stringify(value), raw); assert.notEqual(up.volumes[0], value.volumes[0]);
});
test('相邻批次移动保持所选和未选分集各自相对序', () => {
  const value = book(), ids = [value.volumes[1].id, value.volumes[2].id];
  assert.deepEqual(titles(moveVolumes(value, value.projectId, ids, 'up')), ['乙', '丙', '甲', '丁', '戊']);
  assert.deepEqual(titles(moveVolumes(value, value.projectId, ids, 'down')), ['甲', '丁', '乙', '丙', '戊']);
});
test('不相邻批次和首尾边界移动保持稳定顺序', () => {
  const value = book(), ids = [value.volumes[0].id, value.volumes[2].id, value.volumes[4].id];
  assert.deepEqual(titles(moveVolumes(value, value.projectId, ids, 'up')), ['甲', '丙', '乙', '戊', '丁']);
  assert.deepEqual(titles(moveVolumes(value, value.projectId, ids, 'down')), ['乙', '甲', '丁', '丙', '戊']);
  assert.deepEqual(moveVolumes(value, value.projectId, value.volumes.map(v => v.id), 'down'), value);
});
test('删除仅删除所选分集元数据，保留书信息和其他分集', () => {
  const value = book(), before = structuredClone(value), result = removeVolumes(value, value.projectId, [value.volumes[0].id, value.volumes[2].id]);
  assert.deepEqual(titles(result), ['乙', '丁', '戊']); assert.equal(result.title, value.title); assert.deepEqual(value, before);
  assert.equal(removeVolumes(value, value.projectId, value.volumes.map(v => v.id)).volumes.length, 0);
});
test('批量章节移动使用完整路径且只影响所选路径，目录缺失映射保留', () => {
  const value = book(), before = structuredClone(value), first = value.volumes[0].chapters[0], second = value.volumes[1].chapters[0];
  value.volumes[0].chapters.push('已移出磁盘/缺失.txt'); before.volumes[0].chapters.push('已移出磁盘/缺失.txt');
  const result = assignVolumeChapters(value, value.projectId, [first, second], value.volumes[3].id, value.volumes.flatMap(v => v.chapters).filter(p => !p.includes('缺失')));
  assert.deepEqual(result.volumes[0].chapters, ['已移出磁盘/缺失.txt']); assert.deepEqual(result.volumes[1].chapters, []);
  assert.deepEqual(result.volumes[3].chapters, ['目录3/同名.docx', first, second]); assert.deepEqual(result.volumes[2], before.volumes[2]); assert.deepEqual(value, before);
});
test('重复归入同一分集不重复，移出后未选映射保留', () => {
  const value = book(), first = value.volumes[0].chapters[0], available = value.volumes.flatMap(v => v.chapters);
  const assigned = assignVolumeChapters(value, value.projectId, [first], value.volumes[0].id, available); assert.deepEqual(assigned, value);
  const result = assignVolumeChapters(assigned, value.projectId, [first], null, available); assert.deepEqual(result.volumes[0].chapters, []); assert.deepEqual(result.volumes.slice(1), value.volumes.slice(1));
});
test('所有操作拒绝其他小说、未知分集、重复分集和空选择', () => {
  const value = book(), id = value.volumes[0].id;
  for (const operation of [moveVolumes, removeVolumes]) {
    assert.throws(() => operation(value, randomUUID(), [id], 'up'), /当前小说/);
    assert.throws(() => operation(value, value.projectId, [randomUUID()], 'up'), /当前小说/);
    assert.throws(() => operation(value, value.projectId, [id, id], 'up'), /不重复/);
    assert.throws(() => operation(value, value.projectId, [], 'up'), /请选择/);
  }
  assert.throws(() => assignVolumeChapters(value, randomUUID(), ['甲.txt'], id, ['甲.txt']), /当前小说/);
  assert.throws(() => assignVolumeChapters(value, value.projectId, ['甲.txt'], randomUUID(), ['甲.txt']), /目标分集/);
});
test('章节选择拒绝缺失、重复、同名大小写别名与危险路径', () => {
  const value = book(), id = value.volumes[0].id;
  assert.throws(() => assignVolumeChapters(value, value.projectId, [], id, []), /先选择/);
  assert.throws(() => assignVolumeChapters(value, value.projectId, ['未知.txt'], id, []), /不在/);
  assert.throws(() => assignVolumeChapters(value, value.projectId, ['A.txt', 'a.txt'], id, ['A.txt']), /重复|不在/);
  assert.throws(() => assignVolumeChapters(value, value.projectId, ['A.txt'], id, ['A.txt', 'a.txt']), /目录路径重复/);
  for (const p of ['../原稿.docx', 'C:\\原稿.docx', '/原稿.txt', '目录//原稿.txt', '目录/./原稿.txt', '小说资料.json', '目录/\u0000.txt']) assert.throws(() => assignVolumeChapters(value, value.projectId, [p], id, [p]), /无效/);
});
test('损坏的重复映射、分集 ID、过量分集和未知方向拒绝修改', () => {
  const value = book();
  const duplicate = structuredClone(value); duplicate.volumes[1].chapters = ['目录0\\同名.docx']; assert.throws(() => removeVolumes(duplicate, value.projectId, [value.volumes[0].id]), /只能属于/);
  const duplicateIds = structuredClone(value); duplicateIds.volumes[1].id = duplicateIds.volumes[0].id; assert.throws(() => removeVolumes(duplicateIds, value.projectId, [value.volumes[0].id]), /ID/);
  const invalid = structuredClone(value); invalid.volumes[0].id = '无效'; assert.throws(() => removeVolumes(invalid, value.projectId, ['无效']), /ID/);
  const huge = structuredClone(value); huge.volumes = Array.from({ length: 1001 }, () => ({ id: randomUUID(), title: '卷', introduction: '', cover: '', chapters: [] })); assert.throws(() => removeVolumes(huge, value.projectId, [huge.volumes[0].id]), /1000/);
  assert.throws(() => moveVolumes(value, value.projectId, [value.volumes[0].id], 'side' as 'up'), /移动方向/);
});

test('真实书架保存/重开：排序、批量归属和删除保留 DOCX/TXT/封面原件，隔离另一小说', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-volume-test-'));
  t.after(async () => { assert.match(path.relative(os.tmpdir(), root), /^novel-volume-test-[^\\/]+$/); await fs.rm(root, { recursive: true, force: true }); });
  const workspace = new Workspace(path.join(root, 'local')); await workspace.initialize();
  const folderA = path.join(root, '甲'), folderB = path.join(root, '乙'); await fs.mkdir(folderA); await fs.mkdir(folderB);
  const a = await workspace.attach(folderA), b = await workspace.attach(folderB), library = new LibraryStore(id => workspace.getProject(id));
  const docx = await workspace.createChapter(a.id, textDocument('虚构分集正文原稿。')), txt = await workspace.createChapter(a.id, textDocument('虚构TXT原稿。'), 'txt');
  const originalDocx = await fs.readFile(path.join(folderA, docx.path)), originalTxt = await fs.readFile(path.join(folderA, txt.path));
  const coverBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=', 'base64');
  const cover = await library.addCover(a.id, coverBytes), first = randomUUID(), second = randomUUID(), third = randomUUID();
  let state = await library.read(a.id);
  state = await library.save(a.id, { ...state.value, cover, volumes: [
    { id: first, title: '甲卷', introduction: '引言', cover, chapters: [docx.path, '暂不在目录/缺失.docx'] },
    { id: second, title: '乙卷', introduction: '', cover: '', chapters: [txt.path] },
    { id: third, title: '丙卷', introduction: '', cover: '', chapters: [] }
  ] }, state.hash);
  const oldHash = state.hash, beforeOther = await library.read(b.id);
  let next = moveVolumes(state.value, a.id, [second, third], 'up'); next = assignVolumeChapters(next, a.id, [docx.path, txt.path], third, [docx.path, txt.path]); next = removeVolumes(next, a.id, [first, second]);
  state = await library.save(a.id, next, state.hash);
  const reopened = await new LibraryStore(id => workspace.getProject(id)).read(a.id); assert.deepEqual(reopened, state); assert.deepEqual(titles(reopened.value), ['丙卷']); assert.deepEqual(reopened.value.volumes[0].chapters, [docx.path, txt.path]);
  assert.deepEqual(await fs.readFile(path.join(folderA, docx.path)), originalDocx); assert.deepEqual(await fs.readFile(path.join(folderA, txt.path)), originalTxt); assert.deepEqual(await fs.readFile(path.join(folderA, '小说资料/covers', cover)), coverBytes);
  assert.deepEqual(await library.read(b.id), beforeOther); await assert.rejects(library.save(b.id, next, beforeOther.hash), /另一部小说/);
  await assert.rejects(library.save(a.id, { ...next, introduction: '过期界面不能覆盖' }, oldHash), /已更新/); assert.deepEqual(await library.read(a.id), reopened);
  const histories = await fs.readdir(path.join(folderA, '小说资料/book-history')); assert.ok(histories.length >= 1);
  const unassigned = assignVolumeChapters(state.value, a.id, [docx.path], null, [docx.path, txt.path]); state = await library.save(a.id, unassigned, state.hash); assert.deepEqual(state.value.volumes[0].chapters, [txt.path]);
  state = await library.save(a.id, removeVolumes(state.value, a.id, [third]), state.hash); assert.deepEqual(state.value.volumes, []); assert.deepEqual(await fs.readFile(path.join(folderA, txt.path)), originalTxt);
});
