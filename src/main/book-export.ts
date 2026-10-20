import * as fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import type { Workspace } from './workspace';
import { archiveManifest, assertArchiveTarget, collectArchive, readArchiveFile } from './nas-backup';

/** 整书与固定资料独立分区，控制清单不覆盖任何原件；已有 ZIP 拒绝覆盖。 */
export async function exportBookZip(workspace: Workspace, projectId: string, target: string, now = new Date()) {
  const snapshot = await collectArchive(workspace, projectId);
  const destination = await assertArchiveTarget(snapshot.roots, target);
  // JSZip 在内存中压缩，先限额再读入内容，避免大目录耗尽应用内存。
  if (snapshot.entries.reduce((sum, entry) => sum + entry.bytes, 0) > 256 * 1024 * 1024) throw new Error('ZIP 原始内容超过 256 MiB，请使用文件夹备份');
  const zip = new JSZip();
  for (const entry of snapshot.entries) zip.file(entry.path, await readArchiveFile(entry));
  zip.file('manifest.json', JSON.stringify(archiveManifest(snapshot, now), null, 2));
  const data = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  // 父目录若在准备期间被替换为链接，重新解析并拒绝写到正文/资料内。
  const checked = await assertArchiveTarget(snapshot.roots, destination);
  if (path.relative(checked, destination) !== '') throw new Error('ZIP 目标目录在导出期间发生变化');
  await fs.writeFile(destination, data, { flag: 'wx' });
  return { file: destination, files: snapshot.entries.length, materialsFiles: snapshot.materialsFiles, bytes: data.length, zipBytes: data.length };
}
