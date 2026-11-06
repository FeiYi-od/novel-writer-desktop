import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { moveWithoutReplace, ProjectFolderRename } from '../src/main/project-folder-rename';

async function fixture() {
  const root = await fs.mkdtemp(path.resolve('.artifacts/project-folder-rename-'));
  const local = path.join(root, 'profile'), folder = path.join(root, '虚构甲'), otherFolder = path.join(root, '虚构乙');
  await fs.mkdir(folder); await fs.mkdir(otherFolder); await fs.writeFile(path.join(folder, '第一章.txt'), '　　虚构甲正文。'); await fs.writeFile(path.join(otherFolder, '第一章.txt'), '　　虚构乙正文。');
  const workspace = new Workspace(local, path.join(root, 'materials')); await workspace.initialize();
  const project = await workspace.attach(folder), other = await workspace.attach(otherFolder);
  return { root, local, folder, otherFolder, workspace, project, other };
}

test('小说文件夹改名保留文件与项目身份，更新索引并可重启打开', async () => {
  const f = await fixture(), chapter = await f.workspace.readChapter(f.project.id, '第一章.txt');
  const beforeMeta = await fs.readFile(path.join(f.folder, '小说资料', 'project.json'));
  const result = await f.workspace.renameProjectFolder({ projectId: f.project.id, expectedRoot: f.folder, name: '新的虚构目录' });
  assert.equal(result.id, f.project.id); assert.equal(result.root, path.join(f.root, '新的虚构目录'));
  await assert.rejects(fs.lstat(f.folder), /ENOENT/u); assert.equal(await fs.readFile(path.join(result.root, '第一章.txt'), 'utf8'), '　　虚构甲正文。');
  assert.deepEqual(await fs.readFile(path.join(result.root, '小说资料', 'project.json')), beforeMeta);
  assert.equal((await f.workspace.readChapter(f.project.id, '第一章.txt')).hash, chapter.hash);
  assert.equal(await fs.readFile(path.join(f.otherFolder, '第一章.txt'), 'utf8'), '　　虚构乙正文。');
  const restarted = new Workspace(f.local, path.join(f.root, 'materials')); await restarted.initialize();
  assert.equal(restarted.getProject(f.project.id).root, result.root); assert.equal(restarted.getProject(f.other.id).root, f.otherFolder);
  assert.ok((await fs.readdir(path.join(f.local, 'folder-rename-history'))).length > 0);
});

test('目标重名、非法名称、过期位置或身份变化时拒绝，双方文件保留', async () => {
  const f = await fixture(), request = { projectId: f.project.id, expectedRoot: f.folder };
  for (const name of ['虚构乙', '../越界', 'CON', '无效.', ' 名称']) await assert.rejects(f.workspace.renameProjectFolder({ ...request, name }));
  await assert.rejects(f.workspace.renameProjectFolder({ ...request, expectedRoot: f.otherFolder, name: '新名字' }), /位置已变化/u);
  assert.equal(await fs.readFile(path.join(f.folder, '第一章.txt'), 'utf8'), '　　虚构甲正文。'); assert.equal(await fs.readFile(path.join(f.otherFolder, '第一章.txt'), 'utf8'), '　　虚构乙正文。');
  const meta = path.join(f.folder, '小说资料', 'project.json'); await fs.writeFile(meta, JSON.stringify({ schemaVersion: 1, id: f.other.id, name: '另一身份' }));
  await assert.rejects(f.workspace.renameProjectFolder({ ...request, name: '新名字' }), /身份已变化/u);
  assert.equal(await fs.readFile(path.join(f.folder, '第一章.txt'), 'utf8'), '　　虚构甲正文。');
});

test('索引变动导致中断时保留操作记录，恢复原索引后重新启动可完成关联', async () => {
  const f = await fixture(), indexFile = path.join(f.local, 'library.json'), before = await fs.readFile(indexFile);
  const service = new ProjectFolderRename(f.local, async (from, to) => { await fs.rename(from, to); await fs.writeFile(indexFile, JSON.stringify(['外部变化'])); throw new Error('模拟中断'); });
  await assert.rejects(service.rename(f.project, '中断后的目录'), /模拟中断/u);
  const target = path.join(f.root, '中断后的目录'); assert.equal(await fs.readFile(path.join(target, '第一章.txt'), 'utf8'), '　　虚构甲正文。');
  assert.ok(await fs.stat(path.join(f.local, 'folder-rename-pending.json')));
  const ambiguous = new Workspace(f.local, path.join(f.root, 'materials')); await ambiguous.initialize(); assert.match(ambiguous.folderRenameStatus(), /索引已变化/u);
  await fs.writeFile(indexFile, before);
  const restarted = new Workspace(f.local, path.join(f.root, 'materials')); await restarted.initialize();
  assert.equal(restarted.folderRenameStatus(), ''); assert.equal(restarted.getProject(f.project.id).root, target); assert.equal(restarted.getProject(f.other.id).root, f.otherFolder);
  await assert.rejects(fs.lstat(path.join(f.local, 'folder-rename-pending.json')), /ENOENT/u);
});

test('目录移动后索引尚未更新时，启动恢复按原项目身份完成关联', async () => {
  const f = await fixture(); let moved!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { moved = resolve; }), paused = new Promise<void>(resolve => { release = resolve; });
  const service = new ProjectFolderRename(f.local, async (from, to) => { await fs.rename(from, to); moved(); await paused; });
  const operation = service.rename(f.project, '待恢复目录'); await reached;
  const restarted = new Workspace(f.local, path.join(f.root, 'materials')); await restarted.initialize();
  assert.equal(restarted.folderRenameStatus(), ''); assert.equal(restarted.getProject(f.project.id).root, path.join(f.root, '待恢复目录'));
  assert.equal(await fs.readFile(path.join(f.root, '待恢复目录', '第一章.txt'), 'utf8'), '　　虚构甲正文。');
  release(); assert.equal(await operation, path.join(f.root, '待恢复目录'));
});

test('目标在操作期间出现时不覆盖，损坏操作记录原样保留', async () => {
  const f = await fixture();
  const service = new ProjectFolderRename(f.local, async (_from, to) => { await fs.mkdir(to); await fs.writeFile(path.join(to, '占用者.txt'), '其他资料'); throw new Error('目标出现'); });
  await assert.rejects(service.rename(f.project, '占用目标'), /目标出现/u);
  assert.equal(await fs.readFile(path.join(f.root, '占用目标', '占用者.txt'), 'utf8'), '其他资料');
  assert.equal(await fs.readFile(path.join(f.folder, '第一章.txt'), 'utf8'), '　　虚构甲正文。');
  await assert.rejects(moveWithoutReplace(f.folder, path.join(f.root, '占用目标')), /无法重命名/u);
  assert.equal(await fs.readFile(path.join(f.root, '占用目标', '占用者.txt'), 'utf8'), '其他资料');
  const pending = path.join(f.local, 'folder-rename-pending.json'), raw = '{"schemaVersion":99}'; await fs.writeFile(pending, raw);
  const restarted = new Workspace(f.local, path.join(f.root, 'materials')); await restarted.initialize();
  assert.match(restarted.folderRenameStatus(), /损坏或版本不支持/u); assert.equal(await fs.readFile(pending, 'utf8'), raw);
  assert.equal(restarted.getProject(f.project.id).root, f.folder);
  const indexBefore = await fs.readFile(path.join(f.local, 'library.json'));
  await assert.rejects(restarted.detach(f.project.id), /尚未处理/u);
  await assert.rejects(restarted.attach(f.folder), /尚未处理/u);
  await assert.rejects(restarted.createProject(f.root, '不得新建'), /尚未处理/u);
  assert.deepEqual(await fs.readFile(path.join(f.local, 'library.json')), indexBefore);
});

test('名称中的脚本特殊字符作为普通路径传递，不执行命令', async () => {
  const f = await fixture(), name = '星$(not-a-command)`章';
  const result = await f.workspace.renameProjectFolder({ projectId: f.project.id, expectedRoot: f.folder, name });
  assert.equal(path.basename(result.root), name); assert.equal(await fs.readFile(path.join(result.root, '第一章.txt'), 'utf8'), '　　虚构甲正文。');
});

test('UNC 网络目录暂不执行文件夹改名', async () => {
  const f = await fixture(), service = new ProjectFolderRename(f.local);
  await assert.rejects(service.rename({ id: f.project.id, root: '\\\\server\\share\\虚构书' }, '新目录'), /网络目录.*尚未开放/u);
});

test('创建小说期间发生错误时保留并发写入的文件，不能递归删除目录', async t => {
  const f = await fixture();
  t.mock.method(f.workspace, 'attach', async (folder: string) => { await fs.writeFile(path.join(folder, '外部同时写入.txt'), '必须保留'); throw new Error('模拟关联失败'); });
  await assert.rejects(f.workspace.createProject(f.root, '未完成的新书'), /创建未完成.*已保留/u);
  assert.equal(await fs.readFile(path.join(f.root, '未完成的新书', '外部同时写入.txt'), 'utf8'), '必须保留');
});
