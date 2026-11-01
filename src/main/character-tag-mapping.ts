import * as fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CharacterStore } from './characters';
import type { Workspace } from './workspace';
import { ProjectRecord } from './project-record';

const idText = z.string().trim().min(1).max(256).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const avatar = idText.refine(value => !/[\\/]/u.test(value) && value !== '.' && value !== '..');
const mappingSchema = z.object({ characterId: z.uuid(), avatarKey: avatar, tagIds: z.array(idText).max(100).nullable() }).strict();
const mappingFileSchema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), updatedAt: z.string(), characterHash: z.string().regex(/^(?:[a-f0-9]{64})?$/u), mappings: z.array(mappingSchema).max(200) }).strict().superRefine((value, ctx) => {
  if (new Set(value.mappings.map(item => item.characterId)).size !== value.mappings.length || new Set(value.mappings.map(item => item.avatarKey)).size !== value.mappings.length || value.mappings.some(item => item.tagIds && new Set(item.tagIds).size !== item.tagIds.length))
    ctx.addIssue({ code: 'custom', message: '角色、头像标识或标签 ID 重复' });
});
export type CharacterTagMapping = z.infer<typeof mappingSchema>;
export interface CharacterTagMappingSnapshot { projectId: string; mappings: CharacterTagMapping[]; hash: string; characterHash: string; currentCharacterHash: string; stale: boolean }
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const same = (a: string, b: string) => path.relative(a, b) === '';

/** Explicit author-confirmed references to SillyTavern avatar keys and tag IDs.
 * No mapping is inferred from card names, card data.tags, or unconfirmed text. */
export class CharacterTagMappingStore {
  private readonly record: ProjectRecord<z.infer<typeof mappingFileSchema>>;
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly workspace: Workspace, private readonly characters: Pick<CharacterStore, 'read'>) {
    this.record = new ProjectRecord(workspace, '酒馆角色关联', mappingFileSchema);
  }
  private async guard(projectId: string): Promise<string> {
    const id = z.uuid().parse(projectId), root = this.workspace.getProject(id).root;
    const meta = path.join(root, '小说资料');
    const identities = [];
    for (const directory of [root, meta]) {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !same(directory, await fs.realpath(directory))) throw new Error('酒馆角色关联目录不能使用链接或越界');
      identities.push({ dev: stat.dev, ino: stat.ino });
    }
    const file = path.join(meta, 'project.json'), before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 1024 * 1024 || !same(file, await fs.realpath(file))) throw new Error('小说归属文件不能使用链接或超限内容');
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) throw new Error('小说归属读取前已变化');
      bytes = await handle.readFile();
      const after = await handle.stat(), latest = await fs.lstat(file);
      if (!latest.isFile() || latest.isSymbolicLink() || latest.dev !== opened.dev || latest.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || latest.size !== after.size || latest.mtimeMs !== after.mtimeMs || latest.ctimeMs !== after.ctimeMs) throw new Error('小说归属读取期间已变化');
    } finally { await handle.close(); }
    let metadata: { schemaVersion?: unknown; id?: unknown };
    try { metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error('小说归属资料损坏'); }
    if (metadata.schemaVersion !== 1 || metadata.id !== id) throw new Error('小说归属资料不匹配');
    for (const [index, directory] of [root, meta].entries()) {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identities[index].dev || stat.ino !== identities[index].ino || !same(directory, await fs.realpath(directory))) throw new Error('小说目录或归属已变化');
    }
    return JSON.stringify({ root, identities, projectHash: digest(bytes) });
  }
  private async cardSnapshot(projectId: string) {
    const snapshot = await this.characters.read(projectId);
    if (snapshot.value.projectId !== projectId || snapshot.value.cards.some(card => card.projectId !== projectId)) throw new Error('角色卡不属于当前小说');
    return snapshot;
  }
  async read(projectId: string): Promise<CharacterTagMappingSnapshot> {
    const before = await this.guard(projectId), saved = await this.record.read(projectId), cards = await this.cardSnapshot(projectId);
    if (before !== await this.guard(projectId)) throw new Error('小说归属在读取期间已变化');
    const latestSaved = await this.record.read(projectId), latestCards = await this.cardSnapshot(projectId);
    if (saved.hash !== latestSaved.hash || cards.hash !== latestCards.hash || before !== await this.guard(projectId)) throw new Error('角色卡或酒馆关联在读取期间已变化，请重新核对');
    const value = saved.value;
    const cardIds = new Set(cards.value.cards.map(card => card.id));
    return { projectId, mappings: value?.mappings ?? [], hash: saved.hash, characterHash: value?.characterHash ?? cards.hash, currentCharacterHash: cards.hash,
      stale: value !== null && (value.characterHash !== cards.hash || value.mappings.some(item => !cardIds.has(item.characterId))) };
  }
  async save(projectId: string, mappings: CharacterTagMapping[], expectedHash: string, expectedCharacterHash: string): Promise<CharacterTagMappingSnapshot> {
    const id = z.uuid().parse(projectId);
    const frozen = z.array(mappingSchema).max(200).parse(structuredClone(mappings));
    if (typeof expectedHash !== 'string' || typeof expectedCharacterHash !== 'string') throw new Error('酒馆角色关联版本无效');
    if (new Set(frozen.map(item => item.characterId)).size !== frozen.length || new Set(frozen.map(item => item.avatarKey)).size !== frozen.length) throw new Error('角色或酒馆头像标识重复');
    if (frozen.some(item => item.tagIds && new Set(item.tagIds).size !== item.tagIds.length)) throw new Error('标签 ID 重复');
    const previous = this.queues.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const origin = await this.guard(id), cards = await this.cardSnapshot(id);
      if (cards.hash !== expectedCharacterHash) throw new Error('角色卡已变化，请重新确认关联');
      const ids = new Set(cards.value.cards.map(card => card.id));
      if (frozen.some(item => !ids.has(item.characterId))) throw new Error('关联的角色不属于当前小说');
      if (origin !== await this.guard(id)) throw new Error('小说归属在保存前已变化');
      const saved = await this.record.save(id, { schemaVersion: 1, projectId: id, updatedAt: new Date().toISOString(), characterHash: cards.hash, mappings: frozen }, expectedHash);
      const latest = await this.cardSnapshot(id);
      if (origin !== await this.guard(id) || latest.hash !== cards.hash) throw new Error('保存期间角色卡或小说归属已变化，关联需要重新确认');
      return { projectId: id, mappings: saved.value!.mappings, hash: saved.hash, characterHash: saved.value!.characterHash, currentCharacterHash: latest.hash, stale: false };
    });
    this.queues.set(id, operation);
    void operation.finally(() => { if (this.queues.get(id) === operation) this.queues.delete(id); }).catch(() => {});
    return operation;
  }
}
