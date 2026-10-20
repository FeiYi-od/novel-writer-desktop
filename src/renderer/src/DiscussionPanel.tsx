import { useEffect, useState } from 'react';
import type { AIConnection, DiscussionMessageView } from '../../shared/contracts';

/** Conversation with the model. Old turns are compressed into a summary once the context budget is
 * nearly full; the originals stay in the file and can be unfolded at any time. */
export function DiscussionPanel({ projectId, connections, blocked, onClose }: { projectId: string; connections: AIConnection[]; blocked: boolean; onClose: () => void }) {
  const [messages, setMessages] = useState<DiscussionMessageView[]>([]);
  const [connection, setConnection] = useState(connections[0]?.id ?? '');
  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState<Record<string, DiscussionMessageView[]>>({});
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [note, setNote] = useState('');
  useEffect(() => { let live = true; void window.writer.readDiscussion(projectId).then(snapshot => { if (live) setMessages(snapshot.messages); }).catch(e => { if (live) setError(String(e)); }); return () => { live = false; }; }, [projectId]);
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action(); } catch (e) { setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); } finally { setBusy(false); } };
  const send = () => void run(async () => {
    setNote('');
    const result = await window.writer.askDiscussion(projectId, { text, connectionId: connection });
    setMessages(result.snapshot.messages);
    setText('');
    const live = result.snapshot.messages.filter(message => !message.compressedInto).length;
    setNote(result.compressed ? `已把 ${result.compressed} 条旧消息压缩成摘要（原文保留，可展开）·当前有效 ${live} 条` : `当前有效 ${live} 条`);
  });
  const unfold = (summaryId: string) => void run(async () => { const originals = await window.writer.expandDiscussion(projectId, summaryId); setExpanded(current => ({ ...current, [summaryId]: originals })); });
  const visible = messages.filter(message => !message.compressedInto);
  return <div className="modal-overlay"><section className="book-modal discussion-modal" role="dialog" aria-modal="true" aria-label="与模型讨论">
    <header><div><h2>与模型讨论</h2><p>快到上下文上限时，自动把旧消息压成要点；原文永久保留，点「展开原文」随时查看。</p></div></header>
    {error && <div role="alert" className="error">{error}</div>}{note && <p className="notice" role="status" data-testid="discussion-note">{note}</p>}
    <label>模型<select aria-label="讨论模型" disabled={busy || blocked} value={connection} onChange={e => setConnection(e.target.value)}><option value="">选择模型</option>{connections.map(item => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}</select></label>
    <ol className="discussion-list">{visible.map(message => <li key={message.id} className={`role-${message.role}`}>
      <small>{message.role === 'system' ? '摘要' : message.role === 'assistant' ? '助手' : '作者'}</small>
      <pre>{message.content}</pre>
      {message.role === 'system' && <><button data-testid="discussion-expand" disabled={busy} onClick={() => unfold(message.id)}>展开原文</button>
        {expanded[message.id] && <ul className="discussion-originals">{expanded[message.id]!.map(item => <li key={item.id}><small>{item.role === 'assistant' ? '助手' : '作者'}</small>{item.content}</li>)}</ul>}</>}
    </li>)}</ol>
    {!visible.length && <p>还没有讨论。写下第一个问题。</p>}
    <label>你的问题<textarea aria-label="讨论输入" rows={3} maxLength={8000} disabled={busy || blocked} value={text} onChange={e => setText(e.target.value)} /></label>
    <div className="actions"><button data-testid="discussion-send" className="primary" disabled={busy || blocked || !connection || !text.trim()} onClick={send}>{busy ? '正在讨论…' : '发送'}</button></div>
    <footer><button onClick={onClose}>关闭</button></footer>
  </section></div>;
}
