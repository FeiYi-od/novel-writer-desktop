import type { BookDetails } from '../shared/contracts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pathKey = (value: string) => value.replace(/\\/g, '/').toLocaleLowerCase('en-US');

function chapterPath(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 1000 || /^[\\/]/.test(value) || /[:\u0000-\u001f]/.test(value)
    || value.split(/[\\/]/).some(part => !part || part === '.' || part === '..') || !/\.(docx|txt)$/i.test(value)) throw new Error('无效章节分集路径');
}

function validate(book: BookDetails, projectId: string) {
  if (!uuid.test(projectId) || book.projectId !== projectId || book.schemaVersion !== 1) throw new Error('分集资料不属于当前小说');
  if (book.volumes.length > 1000) throw new Error('每部小说最多1000个分集');
  const ids = new Set<string>(), assigned = new Set<string>();
  for (const volume of book.volumes) {
    if (!uuid.test(volume.id) || ids.has(volume.id)) throw new Error('分集ID无效或重复');
    ids.add(volume.id);
    for (const path of volume.chapters) {
      chapterPath(path); const key = pathKey(path);
      if (assigned.has(key)) throw new Error('同一章节只能属于一个分集');
      assigned.add(key);
    }
  }
}

function selectedVolumes(book: BookDetails, ids: readonly string[]) {
  if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !uuid.test(id) || !book.volumes.some(volume => volume.id === id))) throw new Error('请选择当前小说中不重复的分集');
  return new Set(ids);
}

/** Move each selected contiguous group one position, preserving relative order in both groups. */
export function moveVolumes(book: BookDetails, projectId: string, ids: readonly string[], direction: 'up' | 'down'): BookDetails {
  validate(book, projectId); const selected = selectedVolumes(book, ids);
  if (direction !== 'up' && direction !== 'down') throw new Error('无效分集移动方向');
  const result = structuredClone(book), volumes = result.volumes;
  if (direction === 'up') {
    for (let i = 1; i < volumes.length; i++) if (selected.has(volumes[i].id) && !selected.has(volumes[i - 1].id)) [volumes[i - 1], volumes[i]] = [volumes[i], volumes[i - 1]];
  } else {
    for (let i = volumes.length - 2; i >= 0; i--) if (selected.has(volumes[i].id) && !selected.has(volumes[i + 1].id)) [volumes[i], volumes[i + 1]] = [volumes[i + 1], volumes[i]];
  }
  return result;
}

/** Metadata only: neither chapter files nor cover resources are removed. */
export function removeVolumes(book: BookDetails, projectId: string, ids: readonly string[]): BookDetails {
  validate(book, projectId); const selected = selectedVolumes(book, ids);
  const result = structuredClone(book); result.volumes = result.volumes.filter(volume => !selected.has(volume.id)); return result;
}

/** Only explicit, currently listed chapter paths move; unavailable existing mappings stay intact. */
export function assignVolumeChapters(book: BookDetails, projectId: string, paths: readonly string[], targetId: string | null, availablePaths: readonly string[]): BookDetails {
  validate(book, projectId);
  if (targetId !== null && !book.volumes.some(volume => volume.id === targetId)) throw new Error('目标分集不属于当前小说');
  const available = new Map<string, string>();
  for (const path of availablePaths) {
    chapterPath(path); const key = pathKey(path);
    if (available.has(key)) throw new Error('章节目录路径重复'); available.set(key, path);
  }
  if (!paths.length) throw new Error('请先选择章节');
  const selected = new Set<string>();
  for (const path of paths) {
    chapterPath(path); const key = pathKey(path);
    if (selected.has(key)) throw new Error('章节选择重复');
    if (available.get(key) !== path) throw new Error('所选章节不在当前小说目录中'); selected.add(key);
  }
  const result = structuredClone(book);
  for (const volume of result.volumes) {
    volume.chapters = volume.chapters.filter(path => !selected.has(pathKey(path)));
    if (volume.id === targetId) volume.chapters.push(...paths);
  }
  return result;
}
