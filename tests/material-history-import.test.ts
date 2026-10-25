import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { Workspace } from '../src/main/workspace';
import { MaterialSyncService } from '../src/main/material-sync';
import type { MaterialHistoryImportPreview } from '../src/shared/material-sync';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const request = (preview: MaterialHistoryImportPreview) => ({ projectId: preview.projectId, token: preview.token, fingerprint: preview.fingerprint });
async function fixture() {
  const root = await fs.mkdtemp(path.resolve('.artifacts/material-history-import-040-'));
  const data = path.join(root, 'profile'), materials = path.join(data, '创作资料'), book = path.join(root, '甲/同名虚构小说');
  await fs.mkdir(book, { recursive: true });
  const workspace = new Workspace(data, materials); await workspace.initialize(); const project = await workspace.attach(book);
  const service = new MaterialSyncService(workspace, materials, data), canonical = path.join(materials, project.id);
  await fs.mkdir(canonical, { recursive: true });
  const put = async (folder: string, relative: string, value: string | Buffer) => {
    const file = path.join(folder, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value);
  };
  const archive = async (files: Record<string, string | Buffer>, projectId = project.id) => {
    const id = randomUUID(), folder = path.join(materials, '同步历史', projectId, id); await fs.mkdir(folder, { recursive: true });
    for (const [relative, bytes] of Object.entries(files)) await put(folder, relative, bytes);
    const selected = { projectId, source: 'local' as const, id }, preview = await service.previewHistory(selected);
    return { ...await service.archiveHistory({ ...selected, fingerprint: preview.fingerprint }), original: folder };
  };
  const copyRoot = path.join(book, '小说资料/资料历史导入');
  return { root, data, materials, book, canonical, workspace, project, service, put, archive, copyRoot };
}

test('history ZIP import round-trips exported bytes as one new copy while preserving originals, canonical, baseline and pending journal', async () => {
  const f = await fixture();
  const document = new JSZip(); document.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t xml:space="preserve">　　虚构星港。</w:t></w:r></w:p></w:body></w:document>');
  document.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  const docx = await document.generateAsync({ type: 'nodebuffer' }), image = Buffer.from([0, 255, 1, 128]);
  const draft = `<!-- novel-writer ${JSON.stringify({ schemaVersion: 1, projectId: f.project.id, kind: 'notes' })} -->\n# 未确认草稿\nconfirmed: false\n`;
  const archived = await f.archive({ '人物/草稿.md': draft, '参考.docx': docx, 'character-originals/卡片.png': image, '空.txt': '' });
  await f.put(f.canonical, '当前.txt', '保留最新设定'); await f.service.configure(f.project.id, false);
  const stateFile = path.join(f.data, 'material-sync', `${f.project.id}.json`), state = await fs.readFile(stateFile);
  const pendingFile = path.join(f.data, 'material-sync', `${f.project.id}-pending.json`); await fs.writeFile(pendingFile, '{"unknown":"do not replay"}');
  const zipBefore = await fs.readFile(archived.file), completionFile = path.join(archived.directory, '完成清单.json'), completionBefore = await fs.readFile(completionFile);
  const preview = await f.service.openHistoryArchive(f.project.id, archived.file);
  assert.equal(preview.projectId, f.project.id); assert.equal(preview.source, 'local'); assert.equal(preview.archiveId, path.basename(archived.directory));
  assert.equal(preview.sha256, hash(zipBefore)); assert.equal(preview.archiveBytes, zipBefore.length); assert.equal(preview.name, '历史资料.zip');
  assert.equal(preview.files.find(file => file.path === '当前.txt')!.change, 'current-only');
  assert.ok(!('data' in preview)); assert.ok(!('file' in preview)); await assert.rejects(fs.access(f.copyRoot));
  const detail = await f.service.previewHistoryArchive({ ...request(preview), path: '人物/草稿.md' });
  assert.equal(detail.detail!.historyText, draft); assert.equal(detail.detail!.currentText, undefined);
  const result = await f.service.importHistoryArchive(request(preview));
  assert.equal(result.files, 4); assert.equal(result.sha256, archived.sha256); assert.ok(result.directory.startsWith(f.copyRoot + path.sep));
  assert.deepEqual(await fs.readFile(path.join(result.directory, 'files/参考.docx')), docx);
  assert.deepEqual(await fs.readFile(path.join(result.directory, 'files/character-originals/卡片.png')), image);
  assert.equal(await fs.readFile(path.join(result.directory, 'files/人物/草稿.md'), 'utf8'), draft);
  assert.equal(await fs.readFile(path.join(f.canonical, '当前.txt'), 'utf8'), '保留最新设定'); assert.deepEqual(await fs.readdir(f.canonical), ['当前.txt']);
  assert.deepEqual(await fs.readFile(stateFile), state); assert.equal(await fs.readFile(pendingFile, 'utf8'), '{"unknown":"do not replay"}');
  assert.deepEqual(await fs.readFile(archived.file), zipBefore); assert.deepEqual(await fs.readFile(completionFile), completionBefore);
  assert.deepEqual(await fs.readFile(path.join(archived.original, '参考.docx')), docx);
  const manifest = JSON.parse(await fs.readFile(path.join(result.directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.kind, 'material-history-import-copy'); assert.equal(manifest.archiveId, preview.archiveId); assert.equal(manifest.archiveSha256, hash(zipBefore));
  assert.equal(manifest.completionSha256, hash(completionBefore)); assert.equal(manifest.projectId, f.project.id);
  assert.ok(!JSON.stringify(manifest).includes(f.root));
  await assert.rejects(f.service.importHistoryArchive(request(preview)), /已使用/); assert.equal((await fs.readdir(f.copyRoot)).length, 1);
  await assert.rejects(f.service.previewHistoryArchive(request(preview)), /已使用/);
});

test('history ZIP import previews all four comparison states and bounded pure text without exposing binary', async () => {
  const f = await fixture(), old = await f.archive({ '相同.txt': '同', '变化.txt': '旧', '长.md': '文'.repeat(16001), '图.png': Buffer.from([0, 255]), '页面.html': '<script>fixture</script>' });
  await f.put(f.canonical, '相同.txt', '同'); await f.put(f.canonical, '变化.txt', '新'); await f.put(f.canonical, '新增.txt', '当前');
  const preview = await f.service.openHistoryArchive(f.project.id, old.file);
  assert.equal(preview.files.find(file => file.path === '相同.txt')!.change, 'unchanged');
  assert.equal(preview.files.find(file => file.path === '变化.txt')!.change, 'changed');
  assert.equal(preview.files.find(file => file.path === '长.md')!.change, 'history-only');
  assert.equal(preview.files.find(file => file.path === '新增.txt')!.change, 'current-only');
  const text = await f.service.previewHistoryArchive({ ...request(preview), path: '长.md' }); assert.equal(text.detail!.historyText!.length, 16000); assert.equal(text.detail!.historyTruncated, true);
  for (const relative of ['图.png', '页面.html']) assert.equal((await f.service.previewHistoryArchive({ ...request(preview), path: relative })).detail!.historyText, undefined);
  await assert.rejects(f.service.previewHistoryArchive({ ...request(preview), path: '不存在.txt' }), /不存在/);
});

test('history ZIP import rejects another same-named book and cannot reuse a ticket with another project', async () => {
  const f = await fixture(), secondBook = path.join(f.root, '乙/同名虚构小说'); await fs.mkdir(secondBook, { recursive: true }); const second = await f.workspace.attach(secondBook);
  const old = await f.archive({ '旧.txt': '虚构原稿' }), preview = await f.service.openHistoryArchive(f.project.id, old.file);
  await assert.rejects(f.service.openHistoryArchive(second.id, old.file), /小说|projectId|归属/);
  await assert.rejects(f.service.previewHistoryArchive({ ...request(preview), projectId: second.id }), /票据/);
  await assert.rejects(f.service.importHistoryArchive({ ...request(preview), projectId: second.id }), /票据/);
  await assert.rejects(fs.access(path.join(secondBook, '小说资料/资料历史导入')));
  assert.equal((await f.service.previewHistoryArchive(request(preview))).projectId, f.project.id);
});

test('history ZIP import replaces only its project ticket and rejects forged input, unknown projects and missing completion records', async () => {
  const f = await fixture(), old = await f.archive({ '旧.txt': '虚构原稿' });
  const first = await f.service.openHistoryArchive(f.project.id, old.file), second = await f.service.openHistoryArchive(f.project.id, old.file);
  assert.notEqual(first.token, second.token); await assert.rejects(f.service.previewHistoryArchive(request(first)), /票据/);
  await assert.rejects(f.service.previewHistoryArchive({ ...request(second), token: randomUUID() }), /票据/);
  await assert.rejects(f.service.importHistoryArchive({ ...request(second), fingerprint: '0'.repeat(64) }), /指纹/);
  await assert.rejects(async () => f.service.previewHistoryArchive({ ...request(second), path: '../outside.txt' }));
  await assert.rejects(async () => f.service.importHistoryArchive({ ...request(second), file: old.file } as any));
  await assert.rejects(async () => f.service.openHistoryArchive(randomUUID(), old.file));
  await assert.rejects(async () => f.service.openHistoryArchive(f.project.id, 'relative.zip'), /完整/);
  await assert.rejects(async () => f.service.openHistoryArchive(f.project.id, old.file + '\0'), /完整/);
  const renamed = path.join(old.directory, '另一个名称.zip'); await fs.copyFile(old.file, renamed);
  await assert.rejects(f.service.openHistoryArchive(f.project.id, renamed), /原名/);
  await fs.rename(path.join(old.directory, '完成清单.json'), path.join(old.directory, '保留清单.json'));
  await assert.rejects(f.service.openHistoryArchive(f.project.id, old.file), /完成清单.*缺失/); await assert.rejects(fs.access(f.copyRoot));
});

test('history ZIP import tickets expire after fifteen minutes without generating a destination', async t => {
  const f = await fixture(), old = await f.archive({ '旧.txt': '原稿' }), preview = await f.service.openHistoryArchive(f.project.id, old.file), now = Date.now();
  t.mock.method(Date, 'now', () => now + 16 * 60 * 1000);
  await assert.rejects(f.service.previewHistoryArchive(request(preview)), /过期/); await assert.rejects(f.service.importHistoryArchive(request(preview)), /过期/);
  await assert.rejects(fs.access(f.copyRoot));
});

test('history ZIP import retains at most eight independently scoped tickets and evicts the oldest', async () => {
  const f = await fixture(), previews: MaterialHistoryImportPreview[] = [];
  for (let index = 0; index < 9; index++) {
    const book = path.join(f.root, `票据${index}`); await fs.mkdir(book); const project = await f.workspace.attach(book);
    const old = await f.archive({ '旧.txt': `虚构${index}` }, project.id); previews.push(await f.service.openHistoryArchive(project.id, old.file));
  }
  await assert.rejects(f.service.previewHistoryArchive(request(previews[0])), /票据/);
  for (const preview of previews.slice(1)) assert.equal((await f.service.previewHistoryArchive(request(preview))).projectId, preview.projectId);
});

test('history ZIP import rejects changes to ZIP, completion record, current files or book identity after preview', async t => {
  for (const mutation of ['zip', 'completion', 'current', 'book', 'canonical-identity'] as const) await t.test(mutation, async () => {
    const f = await fixture(), old = await f.archive({ '旧.txt': '历史原稿' }), preview = await f.service.openHistoryArchive(f.project.id, old.file);
    if (mutation === 'zip') await fs.appendFile(old.file, 'changed');
    else if (mutation === 'completion') await fs.appendFile(path.join(old.directory, '完成清单.json'), '\n');
    else if (mutation === 'current') await f.put(f.canonical, '并发.txt', '最新修改');
    else if (mutation === 'book') await fs.appendFile(path.join(f.book, '小说资料/project.json'), '\n');
    else { await fs.rename(f.canonical, f.canonical + '-原件'); await fs.mkdir(f.canonical); }
    await assert.rejects(f.service.previewHistoryArchive(request(preview))); await assert.rejects(f.service.importHistoryArchive(request(preview)));
    await assert.rejects(fs.access(f.copyRoot)); assert.equal(await fs.readFile(path.join(old.original, '旧.txt'), 'utf8'), '历史原稿');
  });
});

test('history ZIP import binds source directory identity even when replacement files have the same bytes', async () => {
  const f = await fixture(), old = await f.archive({ '旧.txt': '历史原稿' }), preview = await f.service.openHistoryArchive(f.project.id, old.file);
  const saved = old.directory + '-原件'; await fs.rename(old.directory, saved); await fs.mkdir(old.directory);
  await fs.copyFile(path.join(saved, '历史资料.zip'), old.file); await fs.copyFile(path.join(saved, '完成清单.json'), path.join(old.directory, '完成清单.json'));
  await assert.rejects(f.service.importHistoryArchive(request(preview)), /变化/); await assert.rejects(fs.access(f.copyRoot));
  assert.equal(hash(await fs.readFile(old.file)), hash(await fs.readFile(path.join(saved, '历史资料.zip'))));
});

test('history ZIP import refuses source and destination directory links without touching their targets', async () => {
  const f = await fixture(), old = await f.archive({ '旧.txt': '历史原稿' });
  const link = path.join(f.root, '归档链接'); await fs.symlink(old.directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.service.openHistoryArchive(f.project.id, path.join(link, '历史资料.zip')), /链接|目录/);
  const preview = await f.service.openHistoryArchive(f.project.id, old.file), outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, f.copyRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.service.importHistoryArchive(request(preview)), /链接|目录/); assert.deepEqual(await fs.readdir(outside), []);
});

test('history ZIP import retains failed temporary copies and never publishes their manifest after source or target changes', async t => {
  for (const mutation of ['source', 'current', 'target', 'target-identity'] as const) await t.test(mutation, async () => {
    const f = await fixture(), old = await f.archive({ '旧.txt': '历史原稿' }), preview = await f.service.openHistoryArchive(f.project.id, old.file);
    const internal = f.service as any, write = internal.writeFiles.bind(internal);
    internal.writeFiles = async (directory: string, tree: unknown) => {
      await write(directory, tree);
      if (mutation === 'source') await fs.appendFile(path.join(old.directory, '完成清单.json'), '\n');
      else if (mutation === 'current') await f.put(f.canonical, '并发.txt', '保留新改动');
      else if (mutation === 'target') await f.put(directory, '并发.txt', '保留目标改动');
      else { await fs.rename(directory, directory + '-原件'); await f.put(directory, '旧.txt', '历史原稿'); }
    };
    await assert.rejects(f.service.importHistoryArchive(request(preview)), /变化/);
    const names = await fs.readdir(f.copyRoot); assert.equal(names.length, 1); const partial = path.join(f.copyRoot, names[0]);
    assert.equal(await fs.readFile(path.join(partial, 'files/旧.txt'), 'utf8'), '历史原稿'); await assert.rejects(fs.access(path.join(partial, 'manifest.json')));
    assert.equal(await fs.readFile(path.join(old.original, '旧.txt'), 'utf8'), '历史原稿');
    if (mutation === 'current') assert.equal(await fs.readFile(path.join(f.canonical, '并发.txt'), 'utf8'), '保留新改动');
    if (mutation === 'target') assert.equal(await fs.readFile(path.join(partial, 'files/并发.txt'), 'utf8'), '保留目标改动');
    if (mutation === 'target-identity') assert.equal(await fs.readFile(path.join(partial, 'files-原件/旧.txt'), 'utf8'), '历史原稿');
  });
});

test('history ZIP import accepts an empty completed archive as an explicit empty new copy', async () => {
  const f = await fixture(), old = await f.archive({}), preview = await f.service.openHistoryArchive(f.project.id, old.file);
  assert.deepEqual(preview.files, []); const result = await f.service.importHistoryArchive(request(preview));
  assert.equal(result.files, 0); assert.equal(result.bytes, 0); assert.deepEqual(await fs.readdir(path.join(result.directory, 'files')), []);
  assert.equal(JSON.parse(await fs.readFile(path.join(result.directory, 'manifest.json'), 'utf8')).kind, 'material-history-import-copy');
});

test('history ZIP import rechecks its destination after the final source verification', async t => {
  for (const mutation of ['content', 'directory-identity'] as const) await t.test(mutation, async () => {
    const f = await fixture(), old = await f.archive({ '旧.txt': '历史原稿' }), preview = await f.service.openHistoryArchive(f.project.id, old.file);
    const internal = f.service as any, inspect = internal.inspectHistoryArchive.bind(internal); let inspections = 0;
    internal.inspectHistoryArchive = async (...args: unknown[]) => {
      const context = await inspect(...args);
      // Initial import read, first source recheck, then the last source recheck.
      // An external edit during that last read must still precede a target check.
      if (++inspections === 3) {
        const names = await fs.readdir(f.copyRoot); assert.equal(names.length, 1);
        const files = path.join(f.copyRoot, names[0], 'files');
        if (mutation === 'content') await fs.writeFile(path.join(files, '旧.txt'), '保留外部目标改动');
        else { await fs.rename(files, files + '-原件'); await f.put(files, '旧.txt', '历史原稿'); }
      }
      return context;
    };
    await assert.rejects(f.service.importHistoryArchive(request(preview)), /变化/);
    assert.equal(inspections, 3);
    const names = await fs.readdir(f.copyRoot); assert.equal(names.length, 1); const partial = path.join(f.copyRoot, names[0]);
    await assert.rejects(fs.access(path.join(partial, 'manifest.json')));
    assert.equal(await fs.readFile(path.join(partial, 'files/旧.txt'), 'utf8'), mutation === 'content' ? '保留外部目标改动' : '历史原稿');
    if (mutation === 'directory-identity') assert.equal(await fs.readFile(path.join(partial, 'files-原件/旧.txt'), 'utf8'), '历史原稿');
    assert.equal(await fs.readFile(path.join(old.original, '旧.txt'), 'utf8'), '历史原稿');
  });
});

test('history ZIP import validates nested project ownership, Markdown versions and forbidden local account files before returning a ticket', async t => {
  for (const mutation of ['markdown-owner', 'markdown-schema', 'json-owner', 'credentials', 'encoding'] as const) await t.test(mutation, async () => {
    const f = await fixture(), old = await f.archive({ '旧.txt': '历史原稿' }), zip = await JSZip.loadAsync(await fs.readFile(old.file));
    const completionFile = path.join(old.directory, '完成清单.json'), completion = JSON.parse(await fs.readFile(completionFile, 'utf8'));
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    const relative = mutation === 'json-owner' ? '关系.json' : mutation === 'credentials' ? 'connections.json' : '创作笔记.md';
    let bytes: Buffer;
    if (mutation === 'markdown-owner') bytes = Buffer.from(`<!-- novel-writer ${JSON.stringify({ schemaVersion: 1, projectId: randomUUID(), kind: 'notes' })} -->\n未确认`);
    else if (mutation === 'markdown-schema') bytes = Buffer.from(`<!-- novel-writer ${JSON.stringify({ schemaVersion: 2, projectId: f.project.id, kind: 'notes' })} -->\n未确认`);
    else if (mutation === 'json-owner') bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, projectId: f.project.id, nested: { projectId: randomUUID() } }));
    else if (mutation === 'credentials') bytes = Buffer.from('{"fixture":"not a real credential"}');
    else bytes = Buffer.from([0xff, 0xfe]);
    zip.file(`files/${relative}`, bytes); manifest.entries.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) }); zip.file('manifest.json', JSON.stringify(manifest));
    const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await fs.writeFile(old.file, archive);
    await fs.writeFile(completionFile, JSON.stringify({ ...completion, ...manifest, bytes: completion.bytes + bytes.length, archiveBytes: archive.length, sha256: hash(archive) }));
    await assert.rejects(f.service.openHistoryArchive(f.project.id, old.file), /归属|版本|另一部|账户|UTF-8/);
    await assert.rejects(fs.access(f.copyRoot)); assert.equal(await fs.readFile(path.join(old.original, '旧.txt'), 'utf8'), '历史原稿');
  });
});
