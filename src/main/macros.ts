import * as fs from 'node:fs/promises';
import path from 'node:path';
import { applyRegexScripts, substituteMacros, type MacroEnv, type RegexScript } from '../core/st-macros';
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
      const raw: unknown = JSON.parse(await fs.readFile(await this.file(projectId), 'utf8'));
      return this.normalize(this.payload(raw));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  private payload(raw: unknown): unknown {
    if (Array.isArray(raw)) return raw;
    if (!raw || typeof raw !== 'object') return undefined;
    const container = raw as Record<string, unknown>;
    if (container.schemaVersion !== undefined && container.schemaVersion !== 1) throw new Error('不支持的正则脚本文件版本，原文件保持不变');
    return container.scripts;
  }
  private normalize(input: unknown): RegexScript[] {
    if (!Array.isArray(input)) throw new Error('正则脚本应为数组（SillyTavern 导出的格式）');
    return input.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`第 ${index + 1} 条脚本缺少 findRegex`);
      const script = item as Record<string, unknown>;
      const findRegex = typeof script.findRegex === 'string' ? script.findRegex : typeof script.find_regex === 'string' ? script.find_regex : '';
      if (!findRegex.trim()) throw new Error(`第 ${index + 1} 条脚本缺少 findRegex`);
      return {
        findRegex,
        replaceString: typeof script.replaceString === 'string' ? script.replaceString : typeof script.replace_string === 'string' ? script.replace_string : '',
        disabled: script.disabled === true,
        // Keep explicit empty/invalid flags: invalid scripts must be skipped by the engine,
        // not silently reinterpreted with different flags.
        flags: typeof script.flags === 'string' ? script.flags : undefined,
        trimStrings: Array.isArray(script.trimStrings) ? script.trimStrings.filter((value): value is string => typeof value === 'string') : []
      };
    });
  }
  async import(projectId: string, json: unknown) {
    const scripts = this.normalize(this.payload(json));
    if (!scripts.length) throw new Error('这份文件里没有正则脚本');
    await fs.writeFile(await this.file(projectId), JSON.stringify({ schemaVersion: 1, scripts }, null, 2), 'utf8');
    return scripts;
  }
  async preview(projectId: string, text: string, context: MacroContext = {}) {
    this.workspace.getProject(projectId);
    const character = context.characterName ?? '';
    const env: MacroEnv = {
      char: character, user: context.userName ?? '作者', description: '', personality: '', scenario: '',
      persona: '', mesExamples: '', lastMessage: context.lastMessage ?? '', original: text,
      seed: `${projectId}:${character}`
    };
    const [notes, scripts] = await Promise.all([this.workspace.readNotes(projectId).catch(() => null), this.read(projectId)]);
    const expanded = substituteMacros(text, env);
    const applied = applyRegexScripts(expanded, scripts, env);
    return { expanded, applied, scripts: scripts.length, notesPresent: Boolean(notes?.value.preset || notes?.value.world) };
  }
}
