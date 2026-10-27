import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { Workspace } from '../src/main/workspace';
import { MaterialSyncService } from '../src/main/material-sync';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
async function tree(root: string): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  const walk = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), relative = path.relative(root, file);
      if (entry.isSymbolicLink()) output[relative] = `link:${await fs.readlink(file)}`;
      else if (entry.isDirectory()) { output[relative] = 'directory'; await walk(file); }
      else { assert.ok(entry.isFile()); output[relative] = hash(await fs.readFile(file)); }
    }
  };
  try { await walk(root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return output;
}
async function fixture() {
  const root = await fs.mkdtemp(path.resolve('.artifacts/material-history-dag-store-047-'));
  const data = path.join(root, 'profile'), materials = path.join(data, '创作资料'), book = path.join(root, '甲/同名虚构小说');
  await fs.mkdir(book, { recursive: true });
  const workspace = new Workspace(data, materials); await workspace.initialize(); const project = await workspace.attach(book);
  const canonical = path.join(materials, project.id); await fs.mkdir(canonical, { recursive: true });
  const service = new MaterialSyncService(workspace, materials, data), versions = path.join(book, '小说资料/创作资料同步/版本');
  const localHistory = path.join(materials, '同步历史', project.id), outputRoot = path.join(book, '小说资料/完整历史归档');
  const put = async (folder: string, relative: string, value: string | Buffer) => {
    const file = path.join(folder, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value);
  };
  const publish = async (files: Record<string, string | Buffer>, parents: string[] = []) => {
    const id = randomUUID(), folder = path.join(versions, id), entries = [];
    await fs.mkdir(path.join(folder, 'files'), { recursive: true });
    for (const [relative, value] of Object.entries(files)) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); await put(path.join(folder, 'files'), relative, bytes);
      entries.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
    }
    const manifest = { schemaVersion: 1, projectId: project.id, revisionId: id, createdAt: new Date().toISOString(), parents, entries };
    const raw = Buffer.from(JSON.stringify(manifest, null, 2).replace(/\n/gu, '\r\n') + '\r\n');
    await fs.writeFile(path.join(folder, 'manifest.json'), raw);
    return { id, folder, manifest, raw };
  };
  const archive = async (files: Record<string, string | Buffer>) => {
    const id = randomUUID(), folder = path.join(localHistory, id); await fs.mkdir(folder, { recursive: true });
    for (const [relative, value] of Object.entries(files)) await put(folder, relative, value);
    return { id, folder };
  };
  const request = (fingerprint: string) => ({ projectId: project.id, fingerprint });
  const preserved = async () => ({ canonical: await tree(canonical), versions: await tree(versions), local: await tree(localHistory), state: await tree(path.join(data, 'material-sync')) });
  return { root, data, materials, book, workspace, project, canonical, service, versions, localHistory, outputRoot, put, publish, archive, request, preserved };
}

test('whole history archive preserves the complete branched transport DAG and separate local originals without touching state or current material', async () => {
  const f = await fixture(), image = Buffer.from([0, 255, 128, 1]);
  const draft = `<!-- novel-writer ${JSON.stringify({ schemaVersion: 1, projectId: f.project.id, kind: 'notes' })} -->\r\n# 未确认草稿\r\nconfirmed: false\r\n`;
  const first = await f.publish({ '人物/草稿.md': draft, 'character-originals/头像.png': image, '空.txt': '' });
  const left = await f.publish({ '共用.txt': '跨版本去重原字节' }, [first.id]);
  const right = await f.publish({ '共用.txt': '跨版本去重原字节' }, [first.id]);
  const merged = await f.publish({ '合并.txt': '保留全部父版本' }, [left.id, right.id]);
  const branch = await f.publish({ '旁支.txt': '未选中分支也必须留档' }, [first.id]);
  const local = await f.archive({ '共用.txt': '跨版本去重原字节', '本机/旧头像.png': image });
  await f.put(f.canonical, '当前.txt', '正式资料保持当前版本'); await f.service.configure(f.project.id, false);
  const stateFile = path.join(f.data, 'material-sync', `${f.project.id}.json`), pending = path.join(f.data, 'material-sync', `${f.project.id}-pending.json`);
  await fs.writeFile(stateFile, 'deliberately unread fictional state'); await fs.writeFile(pending, 'deliberately unread fictional pending');
  const before = await f.preserved(), preview = await f.service.previewHistoryDag(f.project.id);
  assert.equal(preview.schemaVersion, 1); assert.equal(preview.projectId, f.project.id); assert.match(preview.fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(preview.transportVersions, 5); assert.equal(preview.localArchives, 1); assert.equal(preview.branches, 2);
  const expected = new Map<string, Buffer>();
  for (const revision of [first, left, right, merged, branch]) {
    expected.set(hash(revision.raw), revision.raw);
    for (const entry of revision.manifest.entries) { const bytes = await fs.readFile(path.join(revision.folder, 'files', entry.path)); expected.set(hash(bytes), bytes); }
  }
  expected.set(hash('跨版本去重原字节'), Buffer.from('跨版本去重原字节')); expected.set(hash(image), image);
  assert.equal(preview.files, 14); assert.equal(preview.blobs, expected.size); assert.equal(preview.bytes, [...expected.values()].reduce((sum, bytes) => sum + bytes.length, 0));
  assert.deepEqual(await f.preserved(), before, 'Preview must not replay state/pending or modify any original');
  const result = await f.service.archiveHistoryDag(f.request(preview.fingerprint));
  assert.equal(result.projectId, f.project.id); assert.equal(result.fingerprint, preview.fingerprint); assert.equal(result.transportVersions, 5);
  assert.ok(result.directory.startsWith(f.outputRoot + path.sep)); assert.equal(result.file, path.join(result.directory, '完整资料历史.zip'));
  assert.match(result.archiveId, /^[a-f0-9-]{36}$/u);
  const bytes = await fs.readFile(result.file); assert.equal(bytes.length, result.archiveBytes); assert.equal(hash(bytes), result.sha256);
  const zip = await JSZip.loadAsync(bytes), zipped = Object.keys(zip.files).filter(name => !zip.files[name]!.dir).sort();
  assert.deepEqual(zipped, ['manifest.json', ...[...expected.keys()].map(digest => `files/${digest}`)].sort());
  for (const [digest, original] of expected) assert.deepEqual(await zip.file(`files/${digest}`)!.async('nodebuffer'), original);
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.kind, 'material-history-dag-archive'); assert.equal(manifest.projectId, f.project.id);
  assert.deepEqual(new Set(manifest.leaves), new Set([merged.id, branch.id]));
  assert.deepEqual(new Set(manifest.transport.map((item: any) => item.id)), new Set([first.id, left.id, right.id, merged.id, branch.id]));
  assert.deepEqual(manifest.local.map((item: any) => item.id), [local.id]);
  const completion = JSON.parse(await fs.readFile(path.join(result.directory, '完成清单.json'), 'utf8'));
  assert.equal(completion.projectId, f.project.id); assert.equal(completion.archiveId, result.archiveId); assert.equal(completion.sha256, result.sha256);
  assert.equal(completion.archiveBytes, result.archiveBytes); assert.deepEqual(await f.preserved(), before);
  const again = await f.service.archiveHistoryDag(f.request(preview.fingerprint)); assert.notEqual(again.directory, result.directory);
  assert.deepEqual(await f.preserved(), before); assert.equal((await fs.readdir(f.outputRoot)).length, 2);
});

test('local-only history remains independent from transport roots and creates no live synchronization state', async () => {
  const f = await fixture(); await f.archive({ '尚未确认.txt': '本机旧稿不自动成为正史' }); const before = await f.preserved();
  const preview = await f.service.previewHistoryDag(f.project.id); assert.equal(preview.transportVersions, 0); assert.equal(preview.localArchives, 1); assert.equal(preview.branches, 0);
  const result = await f.service.archiveHistoryDag(f.request(preview.fingerprint)); assert.equal(result.files, 1);
  assert.deepEqual(await f.preserved(), before); await assert.rejects(fs.access(path.join(f.data, 'material-sync')));
});

test('same-named books and explicit project/fingerprint requests cannot redirect whole-history archives', async () => {
  const f = await fixture(); await f.publish({ '虚构.txt': '第一本' }); const preview = await f.service.previewHistoryDag(f.project.id);
  const otherBook = path.join(f.root, '乙/同名虚构小说'); await fs.mkdir(otherBook, { recursive: true }); const other = await f.workspace.attach(otherBook);
  const before = await f.preserved(); await assert.rejects(f.service.archiveHistoryDag({ projectId: other.id, fingerprint: preview.fingerprint }));
  await assert.rejects(async () => f.service.previewHistoryDag('invalid-project')); await assert.rejects(async () => f.service.archiveHistoryDag({ projectId: f.project.id, fingerprint: 'invalid' }));
  await assert.rejects(fs.access(f.outputRoot)); await assert.rejects(fs.access(path.join(otherBook, '小说资料/完整历史归档'))); assert.deepEqual(await f.preserved(), before);
});

test('whole-history preview refuses partial uploads, undeclared files, unknown schema, wrong ownership and corrupt payloads', async t => {
  for (const mutation of ['partial', 'undeclared-payload', 'unexpected-root-file', 'schema', 'project', 'hash', 'missing-file', 'nested-project'] as const) await t.test(mutation, async () => {
    const f = await fixture(), revision = await f.publish({ '虚构.txt': '原字节' });
    if (mutation === 'partial') await f.put(path.join(f.versions, randomUUID()), '未完成.txt', '保留部分上传');
    else if (mutation === 'undeclared-payload') await f.put(path.join(revision.folder, 'files'), '额外.txt', '清单未声明');
    else if (mutation === 'unexpected-root-file') await f.put(revision.folder, '额外.txt', '不能静默丢弃');
    else if (mutation === 'schema') await fs.writeFile(path.join(revision.folder, 'manifest.json'), JSON.stringify({ ...revision.manifest, schemaVersion: 2 }));
    else if (mutation === 'project') await fs.writeFile(path.join(revision.folder, 'manifest.json'), JSON.stringify({ ...revision.manifest, projectId: randomUUID() }));
    else if (mutation === 'hash') await fs.appendFile(path.join(revision.folder, 'files/虚构.txt'), '外变');
    else if (mutation === 'missing-file') await fs.writeFile(path.join(revision.folder, 'manifest.json'), JSON.stringify({ ...revision.manifest, entries: [{ ...revision.manifest.entries[0], path: '缺失.txt' }] }));
    else await f.publish({ '归属.json': JSON.stringify({ schemaVersion: 1, projectId: randomUUID() }) });
    const before = await f.preserved(); await assert.rejects(f.service.previewHistoryDag(f.project.id)); assert.deepEqual(await f.preserved(), before);
    await assert.rejects(fs.access(f.outputRoot));
  });
});

test('complete transport DAG rejects missing parents, cycles and duplicate/self parent relationships', async t => {
  for (const mutation of ['missing-parent', 'cycle', 'duplicate-parent', 'self-parent'] as const) await t.test(mutation, async () => {
    const f = await fixture(), first = await f.publish({ '旧.txt': '原稿' }), second = await f.publish({ '新.txt': '新稿' }, [first.id]);
    const manifest = mutation === 'cycle' ? { ...first.manifest, parents: [second.id] }
      : { ...second.manifest, parents: mutation === 'missing-parent' ? [randomUUID()] : mutation === 'duplicate-parent' ? [first.id, first.id] : [second.id] };
    await fs.writeFile(path.join(mutation === 'cycle' ? first.folder : second.folder, 'manifest.json'), JSON.stringify(manifest));
    const before = await f.preserved(); await assert.rejects(f.service.previewHistoryDag(f.project.id)); assert.deepEqual(await f.preserved(), before);
    await assert.rejects(fs.access(f.outputRoot));
  });
});

test('stale previews detect raw manifest whitespace, payload changes, new partial uploads and book metadata edits', async t => {
  for (const mutation of ['raw-manifest', 'payload', 'local', 'new-partial', 'book-identity'] as const) await t.test(mutation, async () => {
    const f = await fixture(), revision = await f.publish({ '虚构.txt': '原稿' }), local = await f.archive({ '旧稿.txt': '原字节' });
    const preview = await f.service.previewHistoryDag(f.project.id);
    if (mutation === 'raw-manifest') await fs.appendFile(path.join(revision.folder, 'manifest.json'), '\r\n');
    else if (mutation === 'payload') await fs.appendFile(path.join(revision.folder, 'files/虚构.txt'), '变化');
    else if (mutation === 'local') await fs.appendFile(path.join(local.folder, '旧稿.txt'), '变化');
    else if (mutation === 'new-partial') await fs.mkdir(path.join(f.versions, randomUUID()));
    else await fs.appendFile(path.join(f.book, '小说资料/project.json'), '\n');
    const before = await f.preserved(); await assert.rejects(f.service.archiveHistoryDag(f.request(preview.fingerprint)));
    assert.deepEqual(await f.preserved(), before); await assert.rejects(fs.access(f.outputRoot));
  });
});

test('source directory replacement with identical bytes invalidates its frozen identity', async () => {
  const f = await fixture(), revision = await f.publish({ '虚构.txt': '相同字节不能冒充相同目录' });
  const preview = await f.service.previewHistoryDag(f.project.id), backup = path.join(f.root, '保留的原历史目录');
  assert.ok(revision.folder.startsWith(f.root + path.sep)); assert.ok(backup.startsWith(f.root + path.sep));
  await fs.rename(revision.folder, backup); await fs.cp(backup, revision.folder, { recursive: true, force: false, dereference: false });
  const before = await f.preserved(); await assert.rejects(f.service.archiveHistoryDag(f.request(preview.fingerprint)));
  assert.deepEqual(await f.preserved(), before); assert.equal(await fs.readFile(path.join(backup, 'files/虚构.txt'), 'utf8'), '相同字节不能冒充相同目录');
  await assert.rejects(fs.access(f.outputRoot));
});

test('linked history payloads or destination parents are never followed', async t => {
  for (const location of ['payload', 'local', 'destination'] as const) await t.test(location, async () => {
    const f = await fixture(), revision = await f.publish({ '虚构.txt': '原稿' });
    const outside = path.join(f.root, '独立虚构目录'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, '保留.txt'), '链接外原字节');
    if (location === 'payload') await fs.symlink(outside, path.join(revision.folder, 'files/链接'), process.platform === 'win32' ? 'junction' : 'dir');
    else if (location === 'local') { await fs.mkdir(f.localHistory, { recursive: true }); await fs.symlink(outside, path.join(f.localHistory, randomUUID()), process.platform === 'win32' ? 'junction' : 'dir'); }
    const before = await f.preserved(), otherBefore = await tree(outside);
    if (location === 'destination') {
      const preview = await f.service.previewHistoryDag(f.project.id); await fs.symlink(outside, f.outputRoot, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(f.service.archiveHistoryDag(f.request(preview.fingerprint)));
    } else await assert.rejects(f.service.previewHistoryDag(f.project.id));
    assert.deepEqual(await f.preserved(), before); assert.deepEqual(await tree(outside), otherBefore);
  });
});

test('aggregate declared I/O budget is rejected before missing large payloads are read', async () => {
  const f = await fixture();
  for (let index = 0; index < 9; index++) {
    const revision = await f.publish({});
    await fs.writeFile(path.join(revision.folder, 'manifest.json'), JSON.stringify({ ...revision.manifest,
      entries: [{ path: '仅声明的虚构大文件.bin', bytes: 32 * 1024 * 1024, sha256: hash('not-loaded-fictional-content') }] }));
  }
  const before = await f.preserved(); await assert.rejects(f.service.previewHistoryDag(f.project.id), /256|预算|总量|累计|引用/u);
  assert.deepEqual(await f.preserved(), before); await assert.rejects(fs.access(f.outputRoot));
});

test('final source verification cannot mark an externally modified ZIP or same-byte replaced target directory complete', async t => {
  for (const mutation of ['zip', 'directory'] as const) await t.test(mutation, async () => {
    const f = await fixture(); await f.publish({ '虚构.txt': '保留原始历史' }); const preview = await f.service.previewHistoryDag(f.project.id);
    const before = await f.preserved(), internal = f.service as any;
    const sourceCheck = internal.assertHistoryDagUnchanged.bind(internal), targetCheck = internal.checkDagArchiveTarget.bind(internal);
    let targetChecks = 0, injected = false, target = '', backup = '';
    internal.checkDagArchiveTarget = async (...args: unknown[]) => { const result = await targetCheck(...args); targetChecks++; return result; };
    internal.assertHistoryDagUnchanged = async (context: unknown) => {
      await sourceCheck(context);
      if (!targetChecks || injected) return;
      const names = await fs.readdir(f.outputRoot); assert.equal(names.length, 1); target = path.join(f.outputRoot, names[0]!); injected = true;
      if (mutation === 'zip') await fs.appendFile(path.join(target, '完整资料历史.zip'), '末次来源复核期间目标被修改');
      else {
        backup = path.join(f.root, '保留的原归档目录'); assert.ok(target.startsWith(f.root + path.sep)); assert.ok(backup.startsWith(f.root + path.sep));
        await fs.rename(target, backup); await fs.mkdir(target); await fs.copyFile(path.join(backup, '完整资料历史.zip'), path.join(target, '完整资料历史.zip'));
      }
    };
    await assert.rejects(f.service.archiveHistoryDag(f.request(preview.fingerprint)), /变化|身份|目录|暂存/u);
    assert.equal(injected, true, 'Mutation must occur after a target check and during the final source verification');
    await assert.rejects(fs.access(path.join(target, '完成清单.json'))); if (backup) await assert.rejects(fs.access(path.join(backup, '完成清单.json')));
    assert.deepEqual(await f.preserved(), before);
  });
});

test('preview rejects BOM-prefixed transport manifests that the canonical history reader and DAG parser reject', async () => {
  const f = await fixture(), revision = await f.publish({ '设定.txt': '虚构设定' });
  await fs.writeFile(path.join(revision.folder, 'manifest.json'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), revision.raw]));
  const before = await f.preserved();
  await assert.rejects(f.service.previewHistoryDag(f.project.id), /清单|UTF/u);
  assert.deepEqual(await f.preserved(), before);
});

test('complete history refuses nested empty directories rather than silently omitting them', async t => {
  for (const source of ['transport', 'local'] as const) await t.test(source, async () => {
    const f = await fixture();
    const version = source === 'transport' ? await f.publish({ '设定.txt': '虚构设定' }) : await f.archive({ '设定.txt': '虚构设定' });
    await fs.mkdir(path.join(version.folder, ...(source === 'transport' ? ['files'] : []), '空目录'));
    const before = await f.preserved();
    await assert.rejects(f.service.previewHistoryDag(f.project.id), /空目录|完整/u);
    assert.deepEqual(await f.preserved(), before);
  });
});

test('preview refuses a first local history directory created during its final source check', async () => {
  const f = await fixture(); await f.publish({ '旧设定.txt': '虚构传输历史' });
  const before = await f.preserved(), internal = f.service as any, original = internal.historyLocations.bind(internal);
  let calls = 0, created: { id: string; folder: string } | undefined;
  internal.historyLocations = async (id: string) => {
    if (++calls === 2) created = await f.archive({ '新本机历史.txt': '由外部创建，必须保留' });
    return original(id);
  };
  await assert.rejects(f.service.previewHistoryDag(f.project.id), /变化|历史/u);
  assert.ok(created); assert.equal(await fs.readFile(path.join(created!.folder, '新本机历史.txt'), 'utf8'), '由外部创建，必须保留');
  const after = await f.preserved(); assert.deepEqual(after.canonical, before.canonical); assert.deepEqual(after.versions, before.versions); assert.deepEqual(after.state, before.state);
  await assert.rejects(fs.access(f.outputRoot));
});

test('last source check refuses a first local history added during inspection and does not publish completion', async () => {
  const f = await fixture(); await f.publish({ '旧设定.txt': '虚构传输历史' });
  const preview = await f.service.previewHistoryDag(f.project.id), before = await f.preserved(), internal = f.service as any;
  const originalLocations = internal.historyLocations.bind(internal), originalSource = internal.assertHistoryDagUnchanged.bind(internal), originalTarget = internal.checkDagArchiveTarget.bind(internal);
  let targetChecks = 0, injected = false, created: { id: string; folder: string } | undefined;
  internal.checkDagArchiveTarget = async (...args: unknown[]) => { const value = await originalTarget(...args); targetChecks++; return value; };
  internal.assertHistoryDagUnchanged = async (context: unknown) => {
    if (targetChecks && !injected) {
      let calls = 0; internal.historyLocations = async (id: string) => {
        if (++calls === 2) { created = await f.archive({ '新本机历史.txt': '外部历史保留' }); injected = true; }
        return originalLocations(id);
      };
      try { return await originalSource(context); } finally { internal.historyLocations = originalLocations; }
    }
    return originalSource(context);
  };
  await assert.rejects(f.service.archiveHistoryDag(f.request(preview.fingerprint)), /变化|历史/u);
  assert.ok(injected && created); assert.equal(await fs.readFile(path.join(created!.folder, '新本机历史.txt'), 'utf8'), '外部历史保留');
  const directories = await fs.readdir(f.outputRoot); assert.equal(directories.length, 1);
  await assert.rejects(fs.access(path.join(f.outputRoot, directories[0]!, '完成清单.json')));
  const after = await f.preserved(); assert.deepEqual(after.canonical, before.canonical); assert.deepEqual(after.versions, before.versions); assert.deepEqual(after.state, before.state);
});

test('preview rechecks locations after inventory and rejects a newly created first local history', async () => {
  const f = await fixture(); await f.publish({ '旧设定.txt': '虚构传输历史' });
  const before = await f.preserved(), internal = f.service as any, original = internal.historyLocations.bind(internal);
  let calls = 0, created: { id: string; folder: string } | undefined;
  internal.historyLocations = async (id: string) => {
    if (++calls === 3) created = await f.archive({ '新本机历史.txt': '最后一轮检查发现的新历史' });
    return original(id);
  };
  await assert.rejects(f.service.previewHistoryDag(f.project.id), /变化|历史/u);
  assert.ok(created); assert.equal(await fs.readFile(path.join(created!.folder, '新本机历史.txt'), 'utf8'), '最后一轮检查发现的新历史');
  const after = await f.preserved(); assert.deepEqual(after.canonical, before.canonical); assert.deepEqual(after.versions, before.versions); assert.deepEqual(after.state, before.state);
  await assert.rejects(fs.access(f.outputRoot));
});

test('preview notices a history entry added during the last location check', async t => {
  for (const source of ['local', 'transport'] as const) await t.test(source, async () => {
    const f = await fixture(); await f.publish({ '旧设定.txt': '虚构历史' });
    if (source === 'local') await f.archive({ '原本机历史.txt': '保留' });
    const before = await f.preserved(), internal = f.service as any, original = internal.historyLocations.bind(internal);
    let calls = 0, injected = '';
    internal.historyLocations = async (id: string) => {
      const locations = await original(id);
      if (++calls === 3) {
        if (source === 'local') injected = (await f.archive({ '新增本机.txt': '新增历史必须保留' })).folder;
        else { injected = path.join(f.versions, randomUUID()); await fs.mkdir(injected); }
      }
      return locations;
    };
    await assert.rejects(f.service.previewHistoryDag(f.project.id), /变化|历史/u);
    assert.ok(injected); assert.ok((await fs.stat(injected)).isDirectory());
    const after = await f.preserved(); assert.deepEqual(after.canonical, before.canonical); assert.deepEqual(after.state, before.state);
    if (source === 'local') assert.deepEqual(after.versions, before.versions); else assert.deepEqual(after.local, before.local);
    await assert.rejects(fs.access(f.outputRoot));
  });
});
