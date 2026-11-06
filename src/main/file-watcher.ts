import * as fs from 'node:fs';

export interface WatcherHandle { close: () => void }
/** Watches one novel folder at a time. Late events from a previous project are dropped by comparing
 * the project id captured in the closure with the active subscription, so switching books can never
 * deliver a stale "file changed" notice to the wrong book. */
export class ChapterWatcher {
  private active: { projectId: string; handle: WatcherHandle; paths: Set<string>; timer: NodeJS.Timeout | null } | null = null;
  constructor(private readonly emit: (projectId: string, paths: string[]) => void, private readonly debounceMs = 250,
    private readonly watch: (folder: string, listener: (event: string, name: string | null) => void) => WatcherHandle =
      (folder, listener) => { const watcher = fs.watch(folder, { recursive: true }, listener); return { close: () => watcher.close() }; }) {}
  get watchedProject() { return this.active?.projectId ?? null; }
  /** Starts (or replaces) the subscription. Only .docx/.txt files are reported. */
  watchProject(projectId: string, folder: string) {
    this.unwatch();
    const paths = new Set<string>();
    const timer: { current: NodeJS.Timeout | null } = { current: null };
    const handle = this.watch(folder, (_event, name) => {
      // Drop anything that arrives after the subscription changed.
      if (!name || this.active?.projectId !== projectId) return;
      if (!/\.(docx|txt)$/iu.test(name)) return;
      // Match Workspace.chapters: metadata and Word lock files are not chapters.
      // Accept both separators because Windows watcher events can use either.
      const segments = name.split(/[\\/]/u);
      if (segments.some(part => part === '小说资料' || part.startsWith('~$'))) return;
      paths.add(name);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        if (this.active?.projectId !== projectId) return;
        const batch = [...paths].sort();
        paths.clear();
        if (batch.length) this.emit(projectId, batch);
      }, this.debounceMs);
      if (this.active) this.active.timer = timer.current;
    });
    this.active = { projectId, handle, paths, timer: timer.current };
  }
  unwatch(projectId?: string) {
    if (!this.active) return;
    if (projectId && this.active.projectId !== projectId) return;
    if (this.active.timer) clearTimeout(this.active.timer);
    try { this.active.handle.close(); } catch { /* closing twice must not throw */ }
    this.active = null;
  }
}
