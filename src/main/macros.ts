import * as fs from 'node:fs/promises';
import path from 'node:path';
import { applyRegexScripts, substituteMacros, type RegexScript } from '../core/st-macros';
import type { Workspace } from './workspace';

export interface MacroContext { characterName?: string; userName?: string; lastMessage?: string }
/** Regex scripts and macro expansion for SillyTavern compatibility, kept per book. */
export class MacroStore {
  constructor(private readonly workspace: Workspace) {}
  private async file(projectId: string) {
    const project = this.workspace.getProject(projectId);
    await fs.mkdir(path.join(project.root, '小说资料'), { recursive: true });
    return path.join(project.root, '小说资料', '正则脚本.json');
  }
  async read(projectId: string): Promise<RegexScript[]> {
    try {
      const raw = JSON.parse(await fs.readFile(await this.file(projectId), 'utf8')) as { scripts?: unknown };
      return this.normalize(Array.isArray(raw) ? raw : raw.scripts);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  private normalize(input: unknown): RegexScript[] {
    if (!Array.isArray(input)) throw new Error('正则脚本应为数组（SillyTavern 导出的格式）');
    return input.map((item, index) => {
      const script = item as Record<string, unknown>;
      const findRegex = typeof script.findRegex === 'string' ? script.findRegex : typeof script.find_regex === 'string' ? script.find_regex : '';
      if (!findRegex.trim()) throw new Error(`第 ${index + 1} 条脚本缺少 findRegex`);
      return {
        findRegex,
        replaceString: typeof script.replaceString === 'string' ? script.replaceString : typeof script.replace_string === 'string' ? script.replace_string : '',
        disabled: script.disabled === true,
        flags: typeof script.flags === 'string' && /^[gimsuy]+$/u.test(script.flags) ? script.flags : undefined,
        trimStrings: Array.isArray(script.trimStrings) ? script.trimStrings.filter((value): value is string => typeof value === 'string') : []
      };
    });
  }
  async import(projectId: string, json: unknown) {
    const scripts = this.normalize(Array.isArray(json) ? json : (json as { scripts?: unknown })?.scripts);
    if (!scripts.length) throw new Error('这份文件里没有正则脚本');
    await fs.writeFile(await this.file(projectId), JSON.stringify({ scripts }, null, 2), 'utf8');
    return scripts;
  }
  async preview(projectId: string, text: string, context: MacroContext = {}) {
    const [notes, cards, books] = await Promise.all([
      this.workspace.readNotes(projectId).catch(() => null),
      this.workspace.getProject(projectId) ? Promise.resolve(null) : Promise.resolve(null),
      Promise.resolve(null)
    ]);
    void cards; void books;
    const character = context.characterName ?? '';
    const expanded = substituteMacros(text, {
      char: character, user: context.userName ?? '作者', description: '', personality: '', scenario: '',
      persona: '', mesExamples: '', lastMessage: context.lastMessage ?? '', original: text,
      seed: `${projectId}:${character}`
    });
    const scripts = await this.read(projectId);
    const applied = applyRegexScripts(expanded, scripts);
    return { expanded, applied, scripts: scripts.length, notesPresent: Boolean(notes?.value.preset || notes?.value.world) };
  }
}
