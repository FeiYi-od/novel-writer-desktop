import { useEffect, useRef } from 'react';

type State = { dirty: boolean; busy: boolean; save?: () => Promise<void>; reason?: string; version?: unknown };
export class ExitSaveRegistry {
  private entries = new Map<symbol, { label: string; state: () => State }>();
  register(label: string, state: () => State) { const id = Symbol(label); this.entries.set(id, { label, state }); return () => { this.entries.delete(id); }; }
  /** Synchronization must never discard a hidden page's draft by remounting it. */
  assertClean(exceptLabel?: string) {
    for (const entry of this.entries.values()) {
      if (entry.label === exceptLabel) continue;
      const state = entry.state();
      if (state.busy || state.dirty) throw new Error(`${entry.label}有未保存内容或正在处理，请先完成后再同步固定资料`);
    }
  }
  preflight() {
    const plan: { label: string; save: () => Promise<void> }[] = [];
    for (const entry of this.entries.values()) {
      const state = entry.state();
      if (state.busy) throw new Error(`${entry.label}正在处理，请等待完成再保存退出`);
      if (!state.dirty) continue;
      if (!state.save) throw new Error(state.reason ?? `${entry.label}有未保存内容，请先保存或确认，再退出`);
      plan.push({ label: entry.label, save: state.save });
    }
    return plan;
  }
  async saveAll(plan: ReturnType<ExitSaveRegistry['preflight']>) { for (const entry of plan) { try { await entry.save(); } catch (e) { throw new Error(`${entry.label}保存失败，窗口和未完成修改保留：${e instanceof Error ? e.message : String(e)}`); } } }
}
export const exitSaves = new ExitSaveRegistry();
export function useSaveBeforeExit(label: string, state: () => State) {
  const latest = useRef(state); latest.current = state;
  useEffect(() => exitSaves.register(label, () => latest.current()), [label]);
}
