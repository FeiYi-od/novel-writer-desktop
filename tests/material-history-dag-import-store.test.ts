import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { Workspace } from '../src/main/workspace';
import { MaterialSyncService } from '../src/main/material-sync';
import { encodeMaterialHistoryDag, parseMaterialHistoryDag, type MaterialDagManifest } from '../src/main/material-history-dag';
import type { MaterialHistoryDagImportPreview } from '../src/shared/material-sync';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const request = (value: MaterialHistoryDagImportPreview) => ({ projectId: value.projectId, token: value.token, fingerprint: value.fingerprint });
async function tree(root: string) {
  const output: Record<string, string> = {};
  const walk = async (folder: string) => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name), relative = path.relative(root, file);
      if (entry.isSymbolicLink()) output[relative] = `link:${await fs.readlink(file)}`;
      else if (entry.isDirectory()) { output[relative] = 'directory'; await walk(file); }
      else { assert.ok(entry.isFile()); output[relative] = hash(await fs.readFile(file)); }
    }
  };
  try { await walk(root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return output;
}

async function fixture() {
  const root = await fs.mkdtemp(path.resolve('.artifacts/material-history-dag-import-048-'));
  const book = path.join(root, '甲/同名虚构小说'), data = path.join(root, 'profile'), materials = path.join(data, '创作资料');
  await fs.mkdir(book, { recursive: true });
  const workspace = new Workspace(data, materials); await workspace.initialize(); const project = await workspace.attach(book);
  const canonical = path.join(materials, project.id), versions = path.join(book, '小说资料/创作资料同步/版本');
  const local = path.join(materials, '同步历史', project.id), output = path.join(book, '小说资料/完整历史导入');
  await fs.mkdir(canonical, { recursive: true });
  const service = new MaterialSyncService(workspace, materials, data);
  const put = async (folder: string, relative: string, value: Buffer | string) => {
    const file = path.join(folder, ...relative.split('/')); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value);
  };
  const publish = async (files: Record<string, Buffer | string>, parents: string[] = []) => {
    const id = randomUUID(), folder = path.join(versions, id), entries: { path: string; bytes: number; sha256: string }[] = [];
    await fs.mkdir(path.join(folder, 'files'), { recursive: true });
    for (const [relative, value] of Object.entries(files)) {
      const data = Buffer.isBuffer(value) ? value : Buffer.from(value); await put(path.join(folder, 'files'), relative, data);
      entries.push({ path: relative, bytes: data.length, sha256: hash(data) });
    }
    const manifest = { schemaVersion: 1, projectId: project.id, revisionId: id, createdAt: new Date().toISOString(), parents, entries };
    const raw = Buffer.from(JSON.stringify(manifest, null, 2).replace(/\n/gu, '\r\n') + '\r\n');
    await fs.writeFile(path.join(folder, 'manifest.json'), raw);
    return { id, folder, manifest, raw };
  };
  const archiveLocal = async (files: Record<string, Buffer | string>) => {
    const id = randomUUID(), folder = path.join(local, id); await fs.mkdir(folder, { recursive: true });
    for (const [relative, value] of Object.entries(files)) await put(folder, relative, value);
    return { id, folder };
  };
  const exportAll = async () => {
    const preview = await service.previewHistoryDag(project.id);
    return service.archiveHistoryDag({ projectId: project.id, fingerprint: preview.fingerprint });
  };
  const copyBundle = async (file: string) => {
    const folder = path.join(root, '选中归档', randomUUID()); await fs.mkdir(folder, { recursive: true });
    const selected = path.join(folder, '完整资料历史.zip'), completion = path.join(folder, '完成清单.json');
    await fs.copyFile(file, selected); await fs.copyFile(path.join(path.dirname(file), '完成清单.json'), completion);
    return { folder, file: selected, completion };
  };
  const preserved = async () => ({ canonical: await tree(canonical), versions: await tree(versions), local: await tree(local), state: await tree(path.join(data, 'material-sync')) });
  const fakeBundle = async (files: Record<string, Buffer | string>) => {
    const id = randomUUID(), blobs = new Map<string, Buffer>();
    const entries = Object.entries(files).map(([relative, value]) => {
      const data = Buffer.isBuffer(value) ? value : Buffer.from(value), sha256 = hash(data); blobs.set(sha256, data);
      return { path: relative, bytes: data.length, sha256 };
    });
    const manifest: MaterialDagManifest = { schemaVersion: 1, kind: 'material-history-dag-archive', projectId: project.id,
      archiveId: randomUUID(), createdAt: new Date().toISOString(), fingerprint: hash('虚构归档来源'), transport: [],
      local: [{ id, createdAt: new Date().toISOString(), entries }], leaves: [],
      blobs: [...blobs].map(([sha256, value]) => ({ sha256, bytes: value.length })).sort((a,b) => a.sha256.localeCompare(b.sha256)) };
    const pair = await encodeMaterialHistoryDag(manifest, blobs);
    // This deliberately validates pure structure first; forbidden metadata must be
    // rejected by the service before it authorizes any import ticket.
    assert.equal(parseMaterialHistoryDag(pair.archive, pair.completion, project.id).manifest.projectId, project.id);
    const folder = path.join(root, '伪造但结构合法', randomUUID()); await fs.mkdir(folder, { recursive: true });
    const file = path.join(folder, '完整资料历史.zip'), completion = path.join(folder, '完成清单.json');
    await fs.writeFile(file, pair.archive); await fs.writeFile(completion, pair.completion);
    return { id, manifest, folder, file, completion };
  };
  return { root, book, data, materials, workspace, project, service, canonical, versions, local, output, put, publish, archiveLocal, exportAll, copyBundle, preserved, fakeBundle };
}

test('complete DAG archive round-trips every branched raw manifest and local file as one independent copy', async () => {
  const f = await fixture(), binary = Buffer.from([0,255,1,128,4]), shared = Buffer.from('　　虚构未确认草稿。\r\n');
  const draft = `<!-- novel-writer ${JSON.stringify({ schemaVersion: 1, projectId: f.project.id, kind: 'notes' })} -->\r\n# 未确认草稿\r\nconfirmed: false\r\n`;
  const first = await f.publish({ '人物/草稿.md': draft, 'character-originals/头像.png': binary }, []);
  const left = await f.publish({ '同文.txt': shared }, [first.id]);
  const right = await f.publish({ '同文.txt': shared }, [first.id]);
  const merged = await f.publish({ '合并.txt': '两个父版本' }, [left.id, right.id]);
  const local = await f.archiveLocal({ '本机/旧稿.txt': shared, '图.png': binary });
  const empty = await f.archiveLocal({});
  await f.put(f.canonical, '当前.txt', '正式资料原样保留'); await f.service.configure(f.project.id, false);
  const stateFile = path.join(f.data, 'material-sync', `${f.project.id}.json`), pending = path.join(f.data, 'material-sync', `${f.project.id}-pending.json`);
  const state = await fs.readFile(stateFile); await fs.writeFile(pending, '{"fictional":"do not replay"}');
  const before = await f.preserved(), exported = await f.exportAll(), bundle = await f.copyBundle(exported.file);
  const zip = await fs.readFile(bundle.file), completion = await fs.readFile(bundle.completion);
  const preview = await f.service.openHistoryDagArchive(f.project.id, bundle.file);
  assert.equal(preview.projectId, f.project.id); assert.equal(preview.schemaVersion, 1); assert.equal(preview.archiveId, exported.archiveId);
  assert.equal(preview.transportVersions, 4); assert.equal(preview.localArchives, 2); assert.equal(preview.branches, 1);
  assert.equal(preview.name, '完整资料历史.zip'); assert.equal(preview.sha256, hash(zip)); assert.equal(preview.archiveBytes, zip.length);
  assert.match(preview.token, /^[a-f0-9-]{36}$/u); assert.match(preview.fingerprint, /^[a-f0-9]{64}$/u);
  assert.ok(Number.isSafeInteger(preview.directories) && preview.directories > 0); assert.ok(!('file' in preview));
  await assert.rejects(fs.access(f.output)); assert.deepEqual(await f.preserved(), before);
  const checked = await f.service.previewHistoryDagArchive(request(preview)); assert.equal(checked.fingerprint, preview.fingerprint);
  const result = await f.service.importHistoryDagArchive(request(preview));
  assert.equal(result.projectId, f.project.id); assert.equal(result.archiveId, preview.archiveId); assert.equal(result.fingerprint, preview.fingerprint);
  assert.ok(result.directory.startsWith(f.output + path.sep)); assert.match(result.copyId, /^[a-f0-9-]{36}$/u);
  for (const version of [first,left,right,merged]) {
    assert.deepEqual(await fs.readFile(path.join(result.directory, 'transport', version.id, 'manifest.json')), version.raw);
    for (const entry of version.manifest.entries) assert.deepEqual(
      await fs.readFile(path.join(result.directory, 'transport', version.id, 'files', ...entry.path.split('/'))),
      await fs.readFile(path.join(version.folder, 'files', ...entry.path.split('/'))));
  }
  assert.deepEqual(await tree(path.join(result.directory, 'local', local.id)), await tree(local.folder));
  assert.deepEqual(await fs.readdir(path.join(result.directory, 'local', empty.id)), []);
  const manifest = JSON.parse(await fs.readFile(path.join(result.directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.kind, 'material-history-dag-import-copy'); assert.equal(manifest.projectId, f.project.id);
  assert.equal(manifest.copyId, result.copyId); assert.equal(manifest.archiveId, preview.archiveId);
  assert.equal(manifest.archiveSha256, hash(zip)); assert.equal(manifest.completionSha256, hash(completion));
  assert.ok(!JSON.stringify(manifest).includes(f.root));
  assert.deepEqual(await f.preserved(), before); assert.deepEqual(await fs.readFile(stateFile), state);
  assert.equal(await fs.readFile(pending, 'utf8'), '{"fictional":"do not replay"}');
  assert.deepEqual(await fs.readFile(bundle.file), zip); assert.deepEqual(await fs.readFile(bundle.completion), completion);
  await assert.rejects(f.service.importHistoryDagArchive(request(preview)), /已使用|票据/u);
  await assert.rejects(f.service.previewHistoryDagArchive(request(preview)), /已使用|票据/u);
  assert.equal((await fs.readdir(f.output)).length, 1);
});

test('same-named books cannot open another project archive or reuse its import ticket', async () => {
  const f = await fixture(); await f.archiveLocal({ '旧稿.txt': '甲本旧稿' }); const exported = await f.exportAll();
  const secondBook = path.join(f.root, '乙/同名虚构小说'); await fs.mkdir(secondBook, { recursive: true });
  const other = await f.workspace.attach(secondBook), preview = await f.service.openHistoryDagArchive(f.project.id, exported.file);
  await assert.rejects(f.service.openHistoryDagArchive(other.id, exported.file), /小说|归属|projectId/u);
  await assert.rejects(f.service.previewHistoryDagArchive({ ...request(preview), projectId: other.id }), /票据|小说/u);
  await assert.rejects(f.service.importHistoryDagArchive({ ...request(preview), projectId: other.id }), /票据|小说/u);
  await assert.rejects(fs.access(f.output)); await assert.rejects(fs.access(path.join(secondBook, '小说资料/完整历史导入')));
});

test('selecting again invalidates the previous ticket, and expiry prevents previews and imports', async t => {
  const f = await fixture(); await f.archiveLocal({ '旧稿.txt': '虚构内容' }); const exported = await f.exportAll();
  const first = await f.service.openHistoryDagArchive(f.project.id, exported.file), second = await f.service.openHistoryDagArchive(f.project.id, exported.file);
  assert.notEqual(first.token, second.token);
  await assert.rejects(f.service.previewHistoryDagArchive(request(first)), /票据|失效|过期/u);
  await assert.rejects(f.service.importHistoryDagArchive(request(first)), /票据|失效|过期/u);
  const originalNow = Date.now(); t.mock.method(Date, 'now', () => originalNow + 16 * 60 * 1000);
  await assert.rejects(f.service.previewHistoryDagArchive(request(second)), /票据|过期/u);
  await assert.rejects(f.service.importHistoryDagArchive(request(second)), /票据|过期/u); await assert.rejects(fs.access(f.output));
});

test('complete archive import rejects wrong names, missing completion, broken bytes and linked source directory before creating target', async t => {
  for (const mutation of ['name','missing-completion','bad-zip','bad-completion','source-link'] as const) await t.test(mutation, async t => {
    const f = await fixture(); await f.archiveLocal({ '旧稿.txt': '原件保留' }); const exported = await f.exportAll(), bundle = await f.copyBundle(exported.file);
    let file = bundle.file;
    if (mutation === 'name') { file = path.join(bundle.folder, '错误名称.zip'); await fs.copyFile(bundle.file, file); }
    if (mutation === 'missing-completion') await fs.unlink(bundle.completion);
    if (mutation === 'bad-zip') await fs.appendFile(bundle.file, '损坏尾部');
    if (mutation === 'bad-completion') await fs.appendFile(bundle.completion, '破坏JSON');
    if (mutation === 'source-link') {
      const link = path.join(f.root, '虚构链接');
      try { await fs.symlink(bundle.folder, link, process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (error) { if (['EPERM','EACCES','ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Symlink permission unavailable'); return; } throw error; }
      file = path.join(link, '完整资料历史.zip');
    }
    const before = await f.preserved(); await assert.rejects(f.service.openHistoryDagArchive(f.project.id, file));
    await assert.rejects(fs.access(f.output)); assert.deepEqual(await f.preserved(), before);
  });
});

test('preview and confirmation reject a modified ZIP, completion, replaced source directory or current material', async t => {
  for (const mutation of ['zip','completion','directory-identity','current','current-directory-identity'] as const) await t.test(mutation, async () => {
    const f = await fixture(); await f.archiveLocal({ '历史.txt': '旧内容' }); await f.put(f.canonical, '当前.txt', '当前内容');
    const exported = await f.exportAll(), bundle = await f.copyBundle(exported.file), preview = await f.service.openHistoryDagArchive(f.project.id, bundle.file);
    if (mutation === 'zip') await fs.appendFile(bundle.file, '额外字节');
    if (mutation === 'completion') await fs.appendFile(bundle.completion, '\n');
    if (mutation === 'directory-identity') {
      const backup = bundle.folder + '-保留原件'; assert.ok(path.resolve(backup).startsWith(path.resolve(f.root) + path.sep));
      await fs.rename(bundle.folder, backup); await fs.mkdir(bundle.folder); await fs.copyFile(path.join(backup, '完整资料历史.zip'), bundle.file); await fs.copyFile(path.join(backup, '完成清单.json'), bundle.completion);
    }
    if (mutation === 'current') await f.put(f.canonical, '当前.txt', '外部新内容');
    if (mutation === 'current-directory-identity') {
      const backup = f.canonical + '-保留原件'; assert.ok(path.resolve(backup).startsWith(path.resolve(f.root) + path.sep));
      await fs.rename(f.canonical, backup); await fs.mkdir(f.canonical); await fs.copyFile(path.join(backup, '当前.txt'), path.join(f.canonical, '当前.txt'));
    }
    const before = await f.preserved();
    await assert.rejects(f.service.previewHistoryDagArchive(request(preview)), /变化|失效|清单|ZIP|身份|哈希/u);
    await assert.rejects(f.service.importHistoryDagArchive(request(preview)), /变化|失效|清单|ZIP|身份|哈希/u);
    await assert.rejects(fs.access(f.output)); assert.deepEqual(await f.preserved(), before);
  });
});

test('structurally valid complete archives still reject forbidden or cross-project metadata per referenced path', async t => {
  for (const mutation of ['credentials-duplicate-blob','markdown-owner','markdown-schema','json-owner','invalid-utf8'] as const) await t.test(mutation, async () => {
    const f = await fixture(); let files: Record<string, Buffer | string>;
    if (mutation === 'credentials-duplicate-blob') files = { '普通.txt': '{}', 'connections.json': '{}' };
    else if (mutation === 'markdown-owner') files = { '人物/草稿.md': `<!-- novel-writer ${JSON.stringify({ schemaVersion: 1, projectId: randomUUID(), kind: 'notes' })} -->\n虚构` };
    else if (mutation === 'markdown-schema') files = { '创作笔记.md': `<!-- novel-writer ${JSON.stringify({ schemaVersion: 2, projectId: f.project.id, kind: 'notes' })} -->\n虚构` };
    else if (mutation === 'json-owner') files = { '状态.json': JSON.stringify({ schemaVersion: 1, projectId: f.project.id, nested: { projectId: randomUUID() } }) };
    else files = { '创作笔记.md': Buffer.from([0xff, 0xfe]) };
    const bundle = await f.fakeBundle(files), before = await f.preserved();
    await assert.rejects(f.service.openHistoryDagArchive(f.project.id, bundle.file), /归属|版本|另一部|账户|UTF-8|文件|小说/u);
    await assert.rejects(fs.access(f.output)); assert.deepEqual(await f.preserved(), before);
  });
});

test('archive parser rejects forged paths, extra blobs, altered contents and missing parents even when the outer ZIP hash is recomputed', async t => {
  for (const mutation of ['traversal','extra-blob','blob-hash','missing-parent'] as const) await t.test(mutation, async () => {
    const f = await fixture(), version = await f.publish({ '历史.txt': '共享虚构字节' });
    await f.archiveLocal({ '同文.txt': '共享虚构字节' });
    const exported = await f.exportAll(), bundle = await f.copyBundle(exported.file), zip = await JSZip.loadAsync(await fs.readFile(bundle.file));
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    if (mutation === 'traversal') manifest.local[0].entries[0].path = '../逃逸.txt';
    if (mutation === 'extra-blob') zip.file(`files/${'f'.repeat(64)}`, '未声明的对象');
    if (mutation === 'blob-hash') {
      const digest = version.manifest.entries[0]!.sha256, original = await zip.file(`files/${digest}`)!.async('nodebuffer');
      zip.file(`files/${digest}`, Buffer.alloc(original.length, 0x58));
    }
    if (mutation === 'missing-parent') {
      const selected = manifest.transport.find((item: { id: string }) => item.id === version.id), previous = selected.manifestSha256;
      const raw = JSON.parse(await zip.file(`files/${previous}`)!.async('string')); raw.parents = [randomUUID()];
      const replacement = Buffer.from(JSON.stringify(raw)), digest = hash(replacement);
      zip.remove(`files/${previous}`); zip.file(`files/${digest}`, replacement); selected.manifestSha256 = digest;
      manifest.blobs = manifest.blobs.filter((item: { sha256: string }) => item.sha256 !== previous);
      manifest.blobs.push({ sha256: digest, bytes: replacement.length });
    }
    zip.file('manifest.json', JSON.stringify(manifest));
    const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const completion = { ...manifest, file: '完整资料历史.zip', bytes: manifest.blobs.reduce((sum: number, item: { bytes: number }) => sum + item.bytes, 0),
      archiveBytes: archive.length, sha256: hash(archive) };
    await fs.writeFile(bundle.file, archive); await fs.writeFile(bundle.completion, JSON.stringify(completion));
    const before = await f.preserved();
    assert.throws(() => parseMaterialHistoryDag(archive, Buffer.from(JSON.stringify(completion)), f.project.id));
    await assert.rejects(f.service.openHistoryDagArchive(f.project.id, bundle.file));
    await assert.rejects(fs.access(f.output)); assert.deepEqual(await f.preserved(), before);
  });
});

test('unique directory budget is enforced before materializing a structurally valid archive', async () => {
  const f = await fixture(), files: Record<string, string> = {};
  // 400 independent chains × 26 directory levels exceed 10,000 distinct
  // target directories while using only 400 entries and one shared blob.
  for (let index = 0; index < 400; index++) files[`${Array.from({ length: 26 }, (_, depth) => `a${index}-${depth}`).join('/')}/旧稿.txt`] = '同一虚构字节';
  const bundle = await f.fakeBundle(files), before = await f.preserved();
  await assert.rejects(f.service.openHistoryDagArchive(f.project.id, bundle.file), /目录|条目|10000|上限/u);
  await assert.rejects(fs.access(f.output)); assert.deepEqual(await f.preserved(), before);
});

test('single-version and complete-DAG imports share one bounded ticket budget without cross-type reselection', async t => {
  const f = await fixture(); let tick = Date.now(); t.mock.method(Date, 'now', () => tick++);
  const openPair = async (index: number) => {
    const book = path.join(f.root, `独立项目${index}`, '同名虚构书'); await fs.mkdir(book, { recursive: true });
    const project = await f.workspace.attach(book), localId = randomUUID(), local = path.join(f.materials, '同步历史', project.id, localId);
    await fs.mkdir(local, { recursive: true }); await f.put(local, '历史.txt', `项目${index}的虚构历史`);
    const singlePreview = await f.service.previewHistory({ projectId: project.id, source: 'local', id: localId });
    const single = await f.service.archiveHistory({ projectId: project.id, source: 'local', id: localId, fingerprint: singlePreview.fingerprint });
    const dagPreview = await f.service.previewHistoryDag(project.id), dag = await f.service.archiveHistoryDag({ projectId: project.id, fingerprint: dagPreview.fingerprint });
    const one = await f.service.openHistoryArchive(project.id, single.file), whole = await f.service.openHistoryDagArchive(project.id, dag.file);
    // Selecting the complete format for this book must not invalidate a valid
    // single-version ticket; their global capacity is nevertheless shared.
    await f.service.previewHistoryArchive({ projectId: project.id, token: one.token, fingerprint: one.fingerprint });
    await f.service.previewHistoryDagArchive(request(whole));
    return { project, one, whole, dag };
  };
  const pairs = [];
  for (let index = 0; index < 4; index++) pairs.push(await openPair(index));
  const extraBook = path.join(f.root, '第五个项目', '同名虚构书'); await fs.mkdir(extraBook, { recursive: true });
  const extra = await f.workspace.attach(extraBook), extraLocal = path.join(f.materials, '同步历史', extra.id, randomUUID());
  await fs.mkdir(extraLocal, { recursive: true }); await f.put(extraLocal, '历史.txt', '第五本虚构历史');
  const extraPreview = await f.service.previewHistoryDag(extra.id), extraDag = await f.service.archiveHistoryDag({ projectId: extra.id, fingerprint: extraPreview.fingerprint });
  const ninth = await f.service.openHistoryDagArchive(extra.id, extraDag.file);
  await f.service.previewHistoryDagArchive(request(ninth));
  const oldest = pairs[0]!;
  await assert.rejects(f.service.previewHistoryArchive({ projectId: oldest.project.id, token: oldest.one.token, fingerprint: oldest.one.fingerprint }), /票据|过期|失效/u);
  await f.service.previewHistoryDagArchive(request(pairs[3]!.whole));
});

test('final source verification cannot mark a modified or same-byte replaced import destination complete', async t => {
  for (const mutation of ['content','directory-identity'] as const) await t.test(mutation, async () => {
    const f = await fixture(); const old = await f.archiveLocal({ '旧稿.txt': '虚构历史原稿' });
    await f.put(f.canonical, '当前.txt', '现有正式资料'); const exported = await f.exportAll(), bundle = await f.copyBundle(exported.file);
    const preview = await f.service.openHistoryDagArchive(f.project.id, bundle.file), before = await f.preserved();
    const sourceZip = await fs.readFile(bundle.file), sourceCompletion = await fs.readFile(bundle.completion);
    const internal = f.service as any, sourceCheck = internal.assertHistoryDagImportUnchanged.bind(internal), targetCheck = internal.checkHistoryDagImportTarget.bind(internal);
    let targetChecks = 0, injected = false, target = '', backup = '';
    internal.checkHistoryDagImportTarget = async (...args: unknown[]) => { const value = await targetCheck(...args); targetChecks++; return value; };
    internal.assertHistoryDagImportUnchanged = async (context: unknown) => {
      const value = await sourceCheck(context);
      if (!targetChecks || injected) return value;
      const names = await fs.readdir(f.output); assert.equal(names.length, 1); target = path.join(f.output, names[0]!); injected = true;
      if (mutation === 'content') await fs.writeFile(path.join(target, 'local', old.id, '旧稿.txt'), '外部修改的目标保留');
      else {
        backup = path.join(f.root, '完整导入原暂存');
        assert.ok(path.resolve(target).startsWith(path.resolve(f.root) + path.sep));
        assert.ok(path.resolve(backup).startsWith(path.resolve(f.root) + path.sep));
        await fs.rename(target, backup); await fs.cp(backup, target, { recursive: true, dereference: false });
      }
      return value;
    };
    await assert.rejects(f.service.importHistoryDagArchive(request(preview)), /变化|身份|目录|暂存/u);
    assert.equal(injected, true); assert.equal(targetChecks, 1, 'Mutation occurs during the last source pass after an earlier target check');
    await assert.rejects(fs.access(path.join(target, 'manifest.json')));
    if (backup) await assert.rejects(fs.access(path.join(backup, 'manifest.json')));
    assert.deepEqual(await f.preserved(), before); assert.deepEqual(await fs.readFile(bundle.file), sourceZip); assert.deepEqual(await fs.readFile(bundle.completion), sourceCompletion);
    assert.equal(await fs.readFile(path.join(old.folder, '旧稿.txt'), 'utf8'), '虚构历史原稿');
    if (mutation === 'content') assert.equal(await fs.readFile(path.join(target, 'local', old.id, '旧稿.txt'), 'utf8'), '外部修改的目标保留');
  });
});

test('final source check rejects an existing nested current file changed during the last archive identity check', async () => {
  const f = await fixture(); await f.archiveLocal({ '旧稿.txt': '虚构历史原稿' });
  await f.put(f.canonical, '子目录/当前.txt', 'OLD-version');
  const exported = await f.exportAll(), bundle = await f.copyBundle(exported.file), preview = await f.service.openHistoryDagArchive(f.project.id, bundle.file);
  const before = await f.preserved(), rootBefore = await fs.lstat(f.canonical), internal = f.service as any;
  const sourceCheck = internal.assertHistoryDagImportUnchanged.bind(internal), targetCheck = internal.checkHistoryDagImportTarget.bind(internal);
  const sourceIdentity = internal.assertDagArchiveSourceIdentity.bind(internal); let targetChecks = 0, injected = false;
  internal.checkHistoryDagImportTarget = async (...args: unknown[]) => { const value = await targetCheck(...args); targetChecks++; return value; };
  internal.assertHistoryDagImportUnchanged = async (context: unknown) => {
    if (targetChecks === 1 && !injected) {
      internal.assertDagArchiveSourceIdentity = async (...args: unknown[]) => {
        const value = await sourceIdentity(...args);
        await fs.writeFile(path.join(f.canonical, '子目录', '当前.txt'), 'NEW-version'); injected = true;
        return value;
      };
      try { return await sourceCheck(context); } finally { internal.assertDagArchiveSourceIdentity = sourceIdentity; }
    }
    return sourceCheck(context);
  };
  await assert.rejects(f.service.importHistoryDagArchive(request(preview)), /变化|当前|历史/u);
  assert.equal(injected, true); const rootAfter = await fs.lstat(f.canonical);
  assert.equal(rootAfter.dev, rootBefore.dev); assert.equal(rootAfter.ino, rootBefore.ino);
  assert.equal(rootAfter.mtimeMs, rootBefore.mtimeMs, 'Nested file changes do not alter the canonical root mtime');
  assert.equal(await fs.readFile(path.join(f.canonical, '子目录', '当前.txt'), 'utf8'), 'NEW-version');
  const names = await fs.readdir(f.output); assert.equal(names.length, 1);
  await assert.rejects(fs.access(path.join(f.output, names[0]!, 'manifest.json')));
  const after = await f.preserved(); assert.deepEqual(after.versions, before.versions); assert.deepEqual(after.local, before.local); assert.deepEqual(after.state, before.state);
});

test('archive selection refuses a nested current edit during the final archive identity check', async () => {
  const f = await fixture(); await f.archiveLocal({ '旧稿.txt': '虚构历史原稿' });
  await f.put(f.canonical, '子目录/当前.txt', 'OLD-version');
  const exported = await f.exportAll(), bundle = await f.copyBundle(exported.file), before = await f.preserved();
  const internal = f.service as any, original = internal.assertDagArchiveSourceIdentity.bind(internal); let injected = false;
  internal.assertDagArchiveSourceIdentity = async (...args: unknown[]) => {
    const value = await original(...args); await fs.writeFile(path.join(f.canonical, '子目录/当前.txt'), 'NEW-version'); injected = true; return value;
  };
  await assert.rejects(f.service.openHistoryDagArchive(f.project.id, bundle.file), /变化|当前|历史/u);
  assert.equal(injected, true); assert.equal(await fs.readFile(path.join(f.canonical, '子目录/当前.txt'), 'utf8'), 'NEW-version');
  const after = await f.preserved(); assert.deepEqual(after.versions, before.versions); assert.deepEqual(after.local, before.local); assert.deepEqual(after.state, before.state);
  await assert.rejects(fs.access(f.output));
});

test('last target check rejects changed book identity before publishing the imported copy', async () => {
  const f = await fixture(); await f.archiveLocal({ '旧稿.txt': '虚构历史' });
  const exported = await f.exportAll(), bundle = await f.copyBundle(exported.file), preview = await f.service.openHistoryDagArchive(f.project.id, bundle.file);
  const projectFile = path.join(f.book, '小说资料/project.json'), original = await fs.readFile(projectFile), before = await f.preserved();
  const internal = f.service as any, sourceCheck = internal.assertHistoryDagImportUnchanged.bind(internal), targetCheck = internal.checkHistoryDagImportTarget.bind(internal);
  let targetChecks = 0, injected = false;
  internal.checkHistoryDagImportTarget = async (...args: unknown[]) => { const value = await targetCheck(...args); targetChecks++; return value; };
  internal.assertHistoryDagImportUnchanged = async (context: unknown) => {
    const value = await sourceCheck(context);
    if (targetChecks === 1 && !injected) { await fs.appendFile(projectFile, ' '); injected = true; }
    return value;
  };
  await assert.rejects(f.service.importHistoryDagArchive(request(preview)), /归属|变化|历史/u);
  assert.equal(injected, true); assert.deepEqual(await fs.readFile(projectFile), Buffer.concat([original, Buffer.from(' ')]));
  const folders = await fs.readdir(f.output); assert.equal(folders.length, 1);
  await assert.rejects(fs.access(path.join(f.output, folders[0]!, 'manifest.json')));
  assert.deepEqual(await f.preserved(), before);
});
