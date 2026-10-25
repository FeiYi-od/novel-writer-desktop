import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { Workspace } from '../src/main/workspace';
import { MaterialSyncService } from '../src/main/material-sync';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const root = await fs.mkdtemp(path.resolve('.artifacts/material-history-036-')), data = path.join(root, 'profile'), materials = path.join(data, '创作资料');
  const book = path.join(root, '虚构星港'); await fs.mkdir(book);
  const workspace = new Workspace(data, materials); await workspace.initialize(); const project = await workspace.attach(book);
  const canonical = path.join(materials, project.id); await fs.mkdir(canonical, { recursive: true });
  const service = new MaterialSyncService(workspace, materials, data), versions = path.join(book, '小说资料/创作资料同步/版本');
  const put = async (folder: string, relative: string, value: string | Buffer) => { const file = path.join(folder, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value); };
  const archive = async (files: Record<string, string | Buffer>) => { const id = randomUUID(), folder = path.join(materials, '同步历史', project.id, id); await fs.mkdir(folder, { recursive: true }); for (const [relative, bytes] of Object.entries(files)) await put(folder, relative, bytes); return { id, folder, source: 'local' as const, projectId: project.id }; };
  const publish = async (files: Record<string, string | Buffer>, parents: string[] = []) => {
    const id = randomUUID(), folder = path.join(versions, id), entries = []; await fs.mkdir(path.join(folder, 'files'), { recursive: true });
    for (const [relative, value] of Object.entries(files)) { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); await put(path.join(folder, 'files'), relative, bytes); entries.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) }); }
    const manifest = { schemaVersion: 1, projectId: project.id, revisionId: id, createdAt: new Date().toISOString(), parents, entries };
    await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest));
    return { id, folder, manifest, source: 'transport' as const, projectId: project.id };
  };
  return { root, book, data, materials, workspace, project, canonical, service, versions, put, archive, publish };
}
const select = (version: { projectId: string; source: 'local' | 'transport'; id: string }) => ({ projectId: version.projectId, source: version.source, id: version.id });

test('history lists all committed ancestors and local archives while disabled without reading all payloads or recovering pending swaps', async () => {
  const f = await fixture(), first = await f.publish({ '旧版.txt': '第一稿' }), second = await f.publish({ '新版.txt': '第二稿' }, [first.id]);
  const local = await f.archive({ '旧资料.txt': '完整原件' }); await f.service.configure(f.project.id, false);
  const stateFile = path.join(f.data, 'material-sync', `${f.project.id}.json`), state = await fs.readFile(stateFile);
  const pendingFile = path.join(f.data, 'material-sync', `${f.project.id}-pending.json`), pending = '{"unknown":"leave untouched"}'; await fs.writeFile(pendingFile, pending);
  // Bad payloads still list with declared counts; opening verifies them instead.
  await fs.writeFile(path.join(first.folder, 'files/旧版.txt'), 'tampered');
  await fs.writeFile(path.join(local.folder, 'invalid.md'), Buffer.from([0xff]));
  const partial = path.join(f.versions, randomUUID()); await fs.mkdir(partial);
  const history = await f.service.history(f.project.id); assert.equal(history.projectId, f.project.id); assert.equal(history.versions.length, 3);
  assert.deepEqual(new Set(history.versions.map(item => item.id)), new Set([first.id, second.id, local.id]));
  assert.equal(history.versions.find(item => item.id === first.id)!.files, 1); assert.equal(history.versions.find(item => item.id === first.id)!.bytes, Buffer.byteLength('第一稿'));
  const archived = history.versions.find(item => item.id === local.id)!; assert.equal(archived.files, null); assert.equal(archived.bytes, null); assert.ok(!Number.isNaN(Date.parse(archived.createdAt)));
  assert.deepEqual(await fs.readFile(stateFile), state); assert.equal(await fs.readFile(pendingFile, 'utf8'), pending);
  await assert.rejects(f.service.previewHistory(select(first)), /哈希/); await assert.rejects(f.service.previewHistory(select(local)), /UTF-8/);
});

test('preview reports all four difference states with full hashes and optional plain-text detail', async () => {
  const f = await fixture(), old = await f.archive({ '相同.txt': '同', '变化.txt': '旧文', '历史.txt': '旧有' });
  await f.put(f.canonical, '相同.txt', '同'); await f.put(f.canonical, '变化.txt', '新文'); await f.put(f.canonical, '当前.txt', '现有');
  const preview = await f.service.previewHistory({ ...select(old), path: '变化.txt' });
  assert.equal(preview.schemaVersion, 1); assert.equal(preview.fingerprint.length, 64);
  assert.deepEqual(Object.fromEntries(preview.files.map(item => [item.path, item.change])), { '变化.txt': 'changed', '历史.txt': 'history-only', '当前.txt': 'current-only', '相同.txt': 'unchanged' });
  assert.equal(preview.files.find(item => item.path === '变化.txt')!.historyHash, hash('旧文'));
  assert.deepEqual(preview.detail, { path: '变化.txt', currentText: '新文', historyText: '旧文', currentTruncated: false, historyTruncated: false });
  const historyOnly = await f.service.previewHistory({ ...select(old), path: '历史.txt', fingerprint: preview.fingerprint }); assert.equal(historyOnly.detail!.currentText, undefined);
  await assert.rejects(f.service.previewHistory({ ...select(old), path: '不存在.txt' }), /不存在/);
});

test('preview bounds UTF-8 text at 16000 characters without returning binary, HTML or invalid UTF-8 bytes', async () => {
  const f = await fixture(), old = await f.archive({ '长文.txt': `${'文'.repeat(15999)}😀尾`, '图片.png': Buffer.from([0, 255, 100]), '坏编码.txt': Buffer.from([0xc3, 0x28]), '页面.html': '<script>fixture</script>', '原卡.json': '{"name":"虚构"}' });
  const text = await f.service.previewHistory({ ...select(old), path: '长文.txt' }); assert.equal(text.detail!.historyText!.length, 15999); assert.equal(text.detail!.historyTruncated, true); assert.ok(!text.detail!.historyText!.includes('\uD83D'));
  for (const relative of ['图片.png', '坏编码.txt', '页面.html']) { const preview = await f.service.previewHistory({ ...select(old), path: relative }); assert.equal(preview.detail!.historyText, undefined); assert.equal(preview.detail!.historyTruncated, false); assert.ok(!('data' in preview)); }
  const card = await f.service.previewHistory({ ...select(old), path: '原卡.json' }); assert.equal(card.detail!.historyText, '{"name":"虚构"}');
});

test('copy preserves every source byte in a new committed folder without modifying canonical, source or baseline', async () => {
  const f = await fixture(), binary = Buffer.from([0, 255, 1, 128]), old = await f.publish({ '人物/草稿.md': '尚未确认的角色建议', 'character-originals/图片.png': binary, '空.txt': '' });
  await f.put(f.canonical, '当前.txt', '保留原件'); await f.service.configure(f.project.id, false);
  const stateFile = path.join(f.data, 'material-sync', `${f.project.id}.json`), state = await fs.readFile(stateFile), sourceManifest = await fs.readFile(path.join(old.folder, 'manifest.json'));
  const preview = await f.service.previewHistory(select(old)), result = await f.service.copyHistory({ ...select(old), fingerprint: preview.fingerprint });
  assert.equal(result.projectId, f.project.id); assert.equal(result.files, 3); assert.ok(result.directory.startsWith(path.join(f.book, '小说资料', '资料历史恢复') + path.sep));
  assert.deepEqual(await fs.readFile(path.join(result.directory, 'files/character-originals/图片.png')), binary);
  assert.equal(await fs.readFile(path.join(result.directory, 'files/人物/草稿.md'), 'utf8'), '尚未确认的角色建议');
  const manifest = JSON.parse(await fs.readFile(path.join(result.directory, 'manifest.json'), 'utf8')); assert.equal(manifest.kind, 'material-history-copy'); assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.projectId, f.project.id); assert.equal(manifest.source, old.source); assert.equal(manifest.id, old.id); assert.equal(manifest.fingerprint, preview.fingerprint);
  assert.equal(manifest.entries.find((entry: any) => entry.path === 'character-originals/图片.png').sha256, hash(binary));
  assert.deepEqual(await fs.readdir(f.canonical), ['当前.txt']); assert.equal(await fs.readFile(path.join(f.canonical, '当前.txt'), 'utf8'), '保留原件'); assert.deepEqual(await fs.readFile(stateFile), state); assert.deepEqual(await fs.readFile(path.join(old.folder, 'manifest.json')), sourceManifest);
  const repeated = await f.service.copyHistory({ ...select(old), fingerprint: preview.fingerprint }); assert.notEqual(repeated.directory, result.directory); assert.deepEqual(await fs.readFile(path.join(repeated.directory, 'files/character-originals/图片.png')), binary);
});

test('local archives can be copied while sharing is off and no state or history is rewritten', async () => {
  const f = await fixture(), old = await f.archive({ '旧稿.txt': '本机旧稿' }), preview = await f.service.previewHistory(select(old));
  const copy = await f.service.copyHistory({ ...select(old), fingerprint: preview.fingerprint }); assert.equal(await fs.readFile(path.join(copy.directory, 'files/旧稿.txt'), 'utf8'), '本机旧稿');
  await assert.rejects(fs.access(path.join(f.data, 'material-sync'))); assert.equal(await fs.readFile(path.join(old.folder, '旧稿.txt'), 'utf8'), '本机旧稿'); assert.deepEqual(await fs.readdir(f.canonical), []);
});

test('source, current data and even manifest-only changes invalidate preview and copy fingerprints', async t => {
  for (const mutation of ['source', 'current', 'manifest'] as const) await t.test(mutation, async () => {
    const f = await fixture(), old = await f.publish({ '旧.txt': '旧' }), preview = await f.service.previewHistory(select(old));
    if (mutation === 'source') await fs.writeFile(path.join(old.folder, 'files/旧.txt'), '外部修改');
    else if (mutation === 'current') await f.put(f.canonical, '新.txt', '新');
    else await fs.appendFile(path.join(old.folder, 'manifest.json'), '\n');
    await assert.rejects(f.service.previewHistory({ ...select(old), fingerprint: preview.fingerprint }), /变化|哈希/);
    await assert.rejects(f.service.copyHistory({ ...select(old), fingerprint: preview.fingerprint }), /变化|哈希/);
    await assert.rejects(fs.access(path.join(f.book, '小说资料/资料历史恢复')));
  });
});

test('local historical edits and book identity edits also invalidate fingerprints', async () => {
  const f = await fixture(), old = await f.archive({ '文件.txt': '原' }), preview = await f.service.previewHistory(select(old));
  await f.put(old.folder, '新增.txt', '新'); await assert.rejects(f.service.copyHistory({ ...select(old), fingerprint: preview.fingerprint }), /变化/);
  const latest = await f.service.previewHistory(select(old)), projectFile = path.join(f.book, '小说资料/project.json'); await fs.appendFile(projectFile, '\n');
  await assert.rejects(f.service.copyHistory({ ...select(old), fingerprint: latest.fingerprint }), /变化/);
});

test('project IDs are explicit and foreign source metadata or swapped books cannot cross boundaries', async () => {
  const f = await fixture(), bookB = path.join(f.root, '另一本'); await fs.mkdir(bookB); const other = await f.workspace.attach(bookB);
  const old = await f.archive({ '世界.txt': 'A的世界' });
  assert.equal((await f.service.history(other.id)).versions.length, 0); await assert.rejects(f.service.previewHistory({ ...select(old), projectId: other.id }), /不存在/);
  const foreign = await f.archive({ '错书.json': JSON.stringify({ schemaVersion: 1, projectId: other.id }) }); await assert.rejects(f.service.previewHistory(select(foreign)), /归属/);
  const preview = await f.service.previewHistory(select(old)); await fs.writeFile(path.join(f.book, '小说资料/project.json'), JSON.stringify({ schemaVersion: 1, id: other.id }));
  await assert.rejects(f.service.copyHistory({ ...select(old), fingerprint: preview.fingerprint }), /归属/);
  await assert.rejects(Promise.resolve().then(() => f.service.history(randomUUID())), /关联/);
});

test('transport preview validates full file tree, unknown schemas, foreign IDs and unsafe manifest paths', async t => {
  for (const corruption of ['extra', 'schema', 'foreign', 'path', 'missing', 'duplicate'] as const) await t.test(corruption, async () => {
    const f = await fixture(), old = await f.publish({ '文件.txt': '原件' }); let manifest = old.manifest;
    if (corruption === 'extra') await f.put(path.join(old.folder, 'files'), '清单外.txt', '不得漏检');
    else if (corruption === 'missing') await fs.unlink(path.join(old.folder, 'files/文件.txt'));
    else { manifest = { ...manifest, ...(corruption === 'schema' ? { schemaVersion: 99 } : corruption === 'foreign' ? { projectId: randomUUID() } : { entries: corruption === 'duplicate' ? [...manifest.entries, manifest.entries[0]] : [{ ...manifest.entries[0], path: '../outside.txt' }] }) } as typeof manifest; await fs.writeFile(path.join(old.folder, 'manifest.json'), JSON.stringify(manifest)); }
    await assert.rejects(f.service.previewHistory(select(old))); assert.deepEqual(await fs.readdir(f.canonical), []);
  });
});

test('links in local archives, canonical roots, transport payloads and recovery destination are refused', async t => {
  for (const location of ['archive', 'canonical', 'payload', 'destination'] as const) await t.test(location, async () => {
    const f = await fixture(), outside = path.join(f.root, 'outside'); await fs.mkdir(outside); const old = location === 'payload' ? await f.publish({ '文件.txt': '旧' }) : await f.archive({ '文件.txt': '旧' });
    const preview = await f.service.previewHistory(select(old));
    const target = location === 'archive' ? path.join(old.folder, 'linked') : location === 'canonical' ? path.join(f.canonical, 'linked') : location === 'payload' ? path.join(old.folder, 'files/linked') : path.join(f.book, '小说资料/资料历史恢复');
    await fs.symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(location === 'destination' ? f.service.copyHistory({ ...select(old), fingerprint: preview.fingerprint }) : f.service.previewHistory(select(old)), /链接|目录/);
    assert.deepEqual(await fs.readdir(outside), []);
  });
});

test('history rejects unsafe requests, missing copy fingerprints and oversized local files', async () => {
  const f = await fixture(), old = await f.archive({ '文件.txt': '旧' });
  for (const unsafe of ['../escape.txt', 'CON.md', 'dir/name:ads', '.hidden.txt']) await assert.rejects(Promise.resolve().then(() => f.service.previewHistory({ ...select(old), path: unsafe })));
  await assert.rejects(Promise.resolve().then(() => f.service.copyHistory(select(old) as any)));
  await assert.rejects(Promise.resolve().then(() => f.service.previewHistory({ ...select(old), source: 'unknown' } as any)));
  await fs.truncate(path.join(old.folder, '文件.txt'), 32 * 1024 * 1024 + 1); await assert.rejects(f.service.previewHistory(select(old)), /大小|过大/);
});

test('copy rechecks source and current files after staging and leaves no success manifest on concurrent edits', async t => {
  for (const mutation of ['source', 'current', 'destination', 'project'] as const) await t.test(mutation, async () => {
    const f = await fixture(), old = await f.archive({ '人物.txt': '历史草稿' }), preview = await f.service.previewHistory(select(old));
    const internal = f.service as any, write = internal.writeFiles.bind(internal); let injected = false;
    internal.writeFiles = async (folder: string, tree: unknown) => {
      await write(folder, tree); if (injected) return; injected = true;
      if (mutation === 'source') await f.put(old.folder, '新资料.txt', '外部更改');
      else if (mutation === 'current') await f.put(f.canonical, '新资料.txt', '外部更改');
      else if (mutation === 'destination') await f.put(folder, '新资料.txt', '外部更改');
      else await fs.appendFile(path.join(f.book, '小说资料/project.json'), '\n');
    };
    await assert.rejects(f.service.copyHistory({ ...select(old), fingerprint: preview.fingerprint }), /变化/);
    const recovery = path.join(f.book, '小说资料/资料历史恢复'), names = await fs.readdir(recovery); assert.equal(names.length, 1);
    await assert.rejects(fs.access(path.join(recovery, names[0], 'manifest.json'))); assert.equal(await fs.readFile(path.join(old.folder, '人物.txt'), 'utf8'), '历史草稿');
    if (mutation === 'current') assert.equal(await fs.readFile(path.join(f.canonical, '新资料.txt'), 'utf8'), '外部更改');
  });
});

test('listing limits local archives before inspecting contents', async () => {
  const f = await fixture(), history = path.join(f.materials, '同步历史', f.project.id); await fs.mkdir(history, { recursive: true });
  await Promise.all(Array.from({ length: 1001 }, () => fs.mkdir(path.join(history, randomUUID()))));
  await assert.rejects(f.service.history(f.project.id), /1000/);
});

test('ZIP archives preserve all source bytes and provenance without altering current data, state or history', async () => {
  const f = await fixture(), raw = Buffer.from([0, 255, 128, 2]);
  const old = await f.publish({ '人物/草稿.md': '未确认草稿：仅供作者核对。', 'character-originals/card.png': raw, '空.txt': '' });
  await f.put(f.canonical, '当前.txt', '当前设定保留'); await f.service.configure(f.project.id, false);
  const stateFile = path.join(f.data, 'material-sync', `${f.project.id}.json`), state = await fs.readFile(stateFile);
  const preview = await f.service.previewHistory(select(old)), archive = await f.service.archiveHistory({ ...select(old), fingerprint: preview.fingerprint });
  const bytes = await fs.readFile(archive.file), zip = await JSZip.loadAsync(bytes);
  assert.equal(hash(bytes), archive.sha256); assert.equal(bytes.length, archive.archiveBytes); assert.equal(archive.files, 3);
  assert.equal(archive.projectId, f.project.id); assert.equal(archive.id, old.id); assert.equal(archive.source, old.source);
  assert.deepEqual(await zip.file('files/character-originals/card.png')!.async('nodebuffer'), raw);
  assert.equal(await zip.file('files/人物/草稿.md')!.async('string'), '未确认草稿：仅供作者核对。');
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
  assert.equal(manifest.kind, 'material-history-archive'); assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.projectId, f.project.id);
  assert.deepEqual(manifest.entries, old.manifest.entries.sort((a, b) => a.path < b.path ? -1 : 1));
  const complete = JSON.parse(await fs.readFile(path.join(archive.directory, '完成清单.json'), 'utf8'));
  assert.equal(complete.sha256, hash(bytes)); assert.equal(complete.archiveBytes, bytes.length);
  assert.equal(await fs.readFile(path.join(f.canonical, '当前.txt'), 'utf8'), '当前设定保留');
  assert.deepEqual(await fs.readFile(stateFile), state); assert.deepEqual(await fs.readFile(path.join(old.folder, 'files/character-originals/card.png')), raw);
  const again = await f.service.archiveHistory({ ...select(old), fingerprint: preview.fingerprint }); assert.notEqual(again.file, archive.file);
});

test('ZIP archives reject stale versions, missing fingerprints and linked destinations', async () => {
  const f = await fixture(), old = await f.archive({ '旧稿.txt': '原稿' }), preview = await f.service.previewHistory(select(old));
  await assert.rejects(Promise.resolve().then(() => f.service.archiveHistory(select(old) as any)));
  await f.put(f.canonical, '新.txt', '更新');
  await assert.rejects(f.service.archiveHistory({ ...select(old), fingerprint: preview.fingerprint }), /变化/);
  const fresh = await f.service.previewHistory(select(old)), outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.book, '小说资料/资料历史归档'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.service.archiveHistory({ ...select(old), fingerprint: fresh.fingerprint }), /链接|目录/);
  assert.deepEqual(await fs.readdir(outside), []); assert.equal(await fs.readFile(path.join(old.folder, '旧稿.txt'), 'utf8'), '原稿');
});

test('archive publication rechecks source, current files and ZIP bytes and never marks an interrupted archive complete', async t => {
  for (const mutation of ['source', 'current', 'zip'] as const) await t.test(mutation, async () => {
    const f = await fixture(), old = await f.archive({ '旧稿.txt': '历史原稿' }), preview = await f.service.previewHistory(select(old));
    const internal = f.service as any, verify = internal.assertHistoryUnchanged.bind(internal); let count = 0;
    internal.assertHistoryUnchanged = async (context: unknown) => {
      await verify(context); if (++count !== 2) return;
      if (mutation === 'source') await f.put(old.folder, '并发.txt', '保留新变动');
      else if (mutation === 'current') await f.put(f.canonical, '并发.txt', '保留新变动');
      else { const root = path.join(f.book, '小说资料/资料历史归档'), names = await fs.readdir(root); await fs.appendFile(path.join(root, names[0], '历史资料.zip'), 'changed'); }
    };
    await assert.rejects(f.service.archiveHistory({ ...select(old), fingerprint: preview.fingerprint }), /变化/);
    const root = path.join(f.book, '小说资料/资料历史归档'), names = await fs.readdir(root); assert.equal(names.length, 1);
    await assert.rejects(fs.access(path.join(root, names[0], '完成清单.json')));
    assert.equal(await fs.readFile(path.join(old.folder, '旧稿.txt'), 'utf8'), '历史原稿');
  });
});

test('ZIP archive size limit refuses large snapshots before creating destination files', async () => {
  const f = await fixture(), old = await f.archive({ '大文件1.bin': '', '大文件2.bin': '', '大文件3.bin': '' });
  for (const name of ['大文件1.bin', '大文件2.bin', '大文件3.bin']) await fs.truncate(path.join(old.folder, name), 24 * 1024 * 1024);
  const preview = await f.service.previewHistory(select(old));
  await assert.rejects(f.service.archiveHistory({ ...select(old), fingerprint: preview.fingerprint }), /64 MiB/);
  await assert.rejects(fs.access(path.join(f.book, '小说资料/资料历史归档')));
});
