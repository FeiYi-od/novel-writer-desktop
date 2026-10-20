import { useState } from 'react';
import type { Manuscript } from '../../shared/contracts';
import './chapter-rename.css';

export function ChapterRename({ target, onRename, onClose }: { target: Manuscript; onRename: (name: string) => Promise<void>; onClose: () => void }) {
  const file = target.path.split(/[\\/]/).at(-1)!; const ext = file.match(/\.[^.]+$/)?.[0] ?? '';
  const [name, setName] = useState(file.slice(0, -ext.length)); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <div className="modal-overlay"><section className="book-modal chapter-rename" role="dialog" aria-modal="true" aria-label="章节重命名">
    <header><h2>章节重命名</h2><button disabled={busy} onClick={onClose} aria-label="关闭重命名">×</button></header>
    <p>当前章节：{target.path}</p><label>新的章节名称（不含扩展名）<input autoFocus aria-label="新的章节名称" maxLength={120} disabled={busy} value={name} onChange={e => { setName(e.target.value); setError(''); }} onKeyDown={e => { if (e.key === 'Escape' && !busy && !e.nativeEvent.isComposing) onClose(); }} /></label>
    <p>保留 {ext.slice(1).toUpperCase()} 格式和所在文件夹，正文内容不变。已有文件不会覆盖，原稿归档保留；分集与摘要继续指向本章。</p>
    <p className="muted">旧名称保留供历史记录定位，不能重新用于其他章节。</p>{error && <div role="alert" className="error">{error}</div>}
    <footer><button disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy || !name.trim()} onClick={() => { setBusy(true); setError(''); void onRename(name).catch(e => setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''))).finally(() => setBusy(false)); }}>{busy ? '正在重命名…' : '确认重命名'}</button></footer>
  </section></div>;
}
