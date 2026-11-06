import { useEffect, useState } from 'react';
import type { Manuscript } from '../../shared/contracts';
import './chapter-rename.css';

export function ChapterRename({ target, displayName, onRename, onClose }: { target: Manuscript; displayName: string; onRename: (name: string, mode: 'file' | 'display', namesHash: string) => Promise<void>; onClose: () => void }) {
  const file = target.path.split(/[\\/]/).at(-1)!; const ext = file.match(/\.[^.]+$/)?.[0] ?? '';
  const [name, setName] = useState(file.slice(0, -ext.length)); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [mode, setMode] = useState<'file' | 'display'>('file');
  const [namesHash, setNamesHash] = useState<string | null>(null); const [namesError, setNamesError] = useState('');
  const [hasDisplayName, setHasDisplayName] = useState(false);
  useEffect(() => { let live = true; void window.writer.chapterDisplayNames(target.projectId).then(snapshot => { if (live) { setNamesHash(snapshot.hash); setHasDisplayName(snapshot.entries.some(entry => entry.path.toLowerCase() === target.path.toLowerCase())); } }).catch(failure => { if (live) setNamesError(String(failure instanceof Error ? failure.message : failure)); }); return () => { live = false; }; }, [target.projectId, target.path]);
  const submit = (value: string) => { setBusy(true); setError(''); void onRename(value, mode, namesHash ?? '').catch(e => setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''))).finally(() => setBusy(false)); };
  return <div className="modal-overlay"><section className="book-modal chapter-rename" role="dialog" aria-modal="true" aria-label="章节重命名">
    <header><h2>章节重命名</h2><button disabled={busy} onClick={onClose} aria-label="关闭重命名">×</button></header>
    <fieldset><legend>修改范围</legend><label><input type="radio" name="chapter-rename-scope" checked={mode === 'file'} disabled={busy} onChange={() => { setMode('file'); setName(file.slice(0, -ext.length)); setError(''); }} />修改实际文件名</label><label><input type="radio" name="chapter-rename-scope" checked={mode === 'display'} disabled={busy || namesHash === null} onChange={() => { setMode('display'); setName(hasDisplayName ? displayName : file.slice(0, -ext.length)); setError(''); }} />仅在本机应用中显示</label></fieldset>
    {namesError && <p role="alert">本机显示名资料无法读取，原文件已保留：{namesError}。仍可修改实际文件名。</p>}
    <p>当前章节：{target.path}</p><label>新的章节名称（不含扩展名）<input autoFocus aria-label="新的章节名称" maxLength={120} disabled={busy} value={name} onChange={e => { setName(e.target.value); setError(''); }} onKeyDown={e => { if (e.key === 'Escape' && !busy && !e.nativeEvent.isComposing) onClose(); }} /></label>
    {mode === 'file' ? <><p>保留 {ext.slice(1).toUpperCase()} 格式和所在文件夹，正文内容不变。已有文件不会覆盖，原稿归档保留；分集与摘要继续指向本章。</p><p className="muted">旧名称保留供历史记录定位，不能重新用于其他章节。已有本机显示名继续保留。</p></> : <p>只改变本机应用里的显示，实际文件名和正文不变；此显示名不会自动同步到其他设备。</p>}
    {error && <div role="alert" className="error">{error}</div>}
    <footer>{mode === 'display' && hasDisplayName && <button disabled={busy || namesHash === null} onClick={() => submit('')}>恢复显示文件名</button>}<button disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy || !name.trim() || (mode === 'display' && namesHash === null)} onClick={() => submit(name)}>{busy ? '正在重命名…' : '确认重命名'}</button></footer>
  </section></div>;
}
