import path from 'node:path';
import { z } from 'zod';
import type { PlanningData, PlanningSnapshot, Project } from '../shared/contracts';
import { emptyPlanning, planningKinds, planningLabels, validateOutline } from '../core/planning';
import { hashText } from './ai-connections';
import { materialDirectory, metadata, readMarkdown, readSection, safeJson, section, writeMarkdown } from './markdown-materials';
const record = <T extends z.ZodType>(value: T) => z.object({ outline: value, world: value, character: value });
const schema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), prompts: record(z.string().max(20000)), briefs: record(z.string().max(50000)), drafts: record(z.string().max(100000)), originTasks: record(z.union([z.literal(''), z.uuid()])), outline: z.string().max(100000) });
export class PlanningStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private getProject: (id: string) => Project, private root: string) {}
  private async file(id: string) { this.getProject(z.uuid().parse(id)); return path.join(await materialDirectory(this.root, id), '创作筹备.md'); }
  async read(id: string): Promise<PlanningSnapshot> {
    const raw = await readMarkdown(await this.file(id));
    if (raw === null) return { value: emptyPlanning(id), hash: '' };
    const meta = metadata(raw, 'planning', id);
    const value = schema.parse({ ...meta, ...Object.fromEntries(['prompts', 'briefs', 'drafts'].map(group => [group, Object.fromEntries(planningKinds.map(kind => [kind, readSection(raw, `${group}:${kind}`)]))])), outline: readSection(raw, 'outline') });
    return { value, hash: hashText(raw) };
  }
  save(id: string, input: PlanningData, expectedHash: string): Promise<PlanningSnapshot> {
    const action = async () => {
      const value = schema.parse(input); if (value.projectId !== id) throw new Error('筹备资料不能写入另一部小说');
      const file = await this.file(id);
      if ((await this.read(id)).hash !== expectedHash) throw new Error('筹备资料已更新，请保留草稿并重新读取');
      const raw = `<!-- novel-writer ${safeJson({ schemaVersion: 1, projectId: id, kind: 'planning', originTasks: value.originTasks })} -->\n# 创作筹备\n\n` + section('outline', '已确认故事大纲', value.outline) + '\n' + planningKinds.map(kind => `# ${planningLabels[kind]}\n\n` + section(`prompts:${kind}`, '作者提示词', value.prompts[kind]) + section(`briefs:${kind}`, '创作构想', value.briefs[kind]) + section(`drafts:${kind}`, '未确认草稿', value.drafts[kind])).join('\n');
      await writeMarkdown(file, raw, expectedHash); return this.read(id);
    };
    const result = this.queue.then(action); this.queue = result.catch(() => {}); return result;
  }
  async acceptOutline(id: string, expectedHash: string) {
    const current = await this.read(id);
    if (current.hash !== expectedHash) throw new Error('筹备资料已更新，未替换大纲');
    return this.save(id, { ...current.value, outline: validateOutline(current.value.drafts.outline) }, expectedHash);
  }
}
