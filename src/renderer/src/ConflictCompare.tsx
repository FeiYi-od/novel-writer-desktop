import { useEffect, useState } from 'react';
import { copyableText } from '../../core/typography';
import type { Manuscript } from '../../shared/contracts';

interface Conflict { path: string; baseName: string; kind: string }
/** 把同步冲突副本与当前章节并排看：只读，不做合并也不删除，作者自己决定抄哪边。 */
export function ConflictCompare({ projectId, document, conflicts, blocked, onClose }: {
  projectId: string; document: Manuscript | null; conflicts: Conflict[]; blocked: boolean; onClose: () => void;
}) {
  const [picked, setPicked] = useState<Conflict | null>(conflicts[0] ?? null);
  const [copy, setCopy] = useState<Manuscript | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [note, setNote] = useState('');
  const pick = async (conflict: Conflict) => {
    setBusy(true); setError(''); setNote('');
    try { setPicked(conflict); setCopy(await window.writer.readChapter(projectId, conflict.path)); }
    catch (e) { setCopy(null); setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); }
    finally { setBusy(false); }
  };
  // 打开面板就先载入第一份副本，省掉一次点击。
  useEffect(() => { const first = conflicts[0]; if (first) void pick(first); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  const current = document && typeof document.content !== 'string' ? copyableText(document.content) : '';
  // 外部 DOCX 读出来是 HTML 字符串，受管章节是富文本节点，两种都要能显示。
  const other = !copy ? '' : typeof copy.content === 'string' ? copy.content.replace(/<[^>]+>/gu, '').trim() : copyableText(copy.content);
  return <div className="modal-overlay"><section className="book-modal conflict-modal" role="dialog" aria-modal="true" aria-label="冲突副本对照">
    <header><div><h2>冲突副本对照</h2><p>同步软件不会合并 Word，只会在旁边留一份副本。这里并排显示两边内容，只读；要不要采纳由你决定。</p></div></header>
    {error && <div role="alert" className="error">{error}</div>}{note && <p role="status">{note}</p>}
    <ul className="conflict-list">{conflicts.map(conflict => <li key={conflict.path}>
      <button disabled={busy || blocked} data-testid="conflict-item" aria-pressed={picked?.path === conflict.path} onClick={() => void pick(conflict)}>{conflict.baseName}</button>
    </li>)}</ul>
    <div className="ai-columns">
      <article className="ai-panel"><h3>当前章节{document ? `：${document.path}` : ''}</h3><pre aria-label="当前章节内容">{current || '（没有打开的章节）'}</pre></article>
      <article className="ai-panel"><h3>冲突副本{picked ? `：${picked.baseName}` : ''}</h3><pre aria-label="冲突副本内容">{other || '（选择左侧副本后显示）'}</pre>
        {copy && <button data-testid="conflict-copy-path" onClick={() => void navigator.clipboard.writeText(copy.path).then(() => setNote('已复制副本文件名，便于在资源管理器里定位')).catch(() => setNote(copy.path))}>复制副本文件名</button>}
      </article>
    </div>
    <footer><button onClick={onClose}>关闭</button></footer>
  </section></div>;
}
