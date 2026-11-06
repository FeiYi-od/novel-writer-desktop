import { useEffect, useRef, useState } from 'react';
import type { CharacterSnapshot, WorldCardEditRequest } from '../../shared/contracts';
import { parseWorldCardDraft, type WorldCardDraft } from '../../core/world-card-draft';
import { WorldTrashMerge } from './WorldTrashMerge';
import './inspector-cards.css';

type WorldBook = Awaited<ReturnType<typeof window.writer.readWorldBook>>;

/** Saved cards only. All reads remain bound to the project that opened this panel. */
export function InspectorCards({ projectId, kind, revision, onOpenWorld, onEditWorld, onBusy }: {
  projectId: string; kind: 'characters' | 'world'; revision: number; onOpenWorld: (book: string) => void; onEditWorld: (request: WorldCardEditRequest) => void; onBusy: (busy: boolean) => void;
}) {
  const [characters, setCharacters] = useState<CharacterSnapshot | null>(null);
  const [worlds, setWorlds] = useState<WorldBook[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trash, setTrash] = useState<Awaited<ReturnType<typeof window.writer.listWorldEntryTrash>> | null>(null);
  const [trashPreview, setTrashPreview] = useState<Awaited<ReturnType<typeof window.writer.previewWorldEntryTrash>> | null>(null);
  const [mergeTarget, setMergeTarget] = useState<{ book: WorldBook; item: Awaited<ReturnType<typeof window.writer.listWorldEntryTrash>>['items'][number] } | null>(null);
  const [actionError, setActionError] = useState('');
  const [message, setMessage] = useState('');
  const [acting, setActing] = useState(false);
  const [worldDraft, setWorldDraft] = useState<WorldCardDraft | null>(null);
  const [draftError, setDraftError] = useState('');
  const pending = useRef(false);
  async function act(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; onBusy(true); setActing(true); setActionError(''); setMessage('');
    try { await action(); }
    catch (failure) { setActionError(String(failure instanceof Error ? failure.message : failure).replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '')); }
    finally { pending.current = false; onBusy(false); setActing(false); }
  }
  useEffect(() => {
    let live = true;
    setCharacters(null); setWorlds([]); setErrors([]); setWorldDraft(null); setDraftError(''); setTrashPreview(null); setLoading(true);
    void (async () => {
      if (kind === 'characters') {
        const result = await window.writer.readCharacters(projectId);
        if (live && result.value.projectId === projectId) setCharacters(result);
      } else {
        try {
          const draft = await window.writer.readUiDraft(projectId, 'world-card');
          if (!live) return;
          if (draft) setWorldDraft(parseWorldCardDraft(projectId, draft));
        } catch (failure) { if (live) setDraftError(String(failure instanceof Error ? failure.message : failure)); }
        const books = await window.writer.listWorldBooks(projectId);
        const problems = books.filter(book => book.error).map(book => `${book.name}：${book.error}`);
        const loaded: WorldBook[] = [];
        // Keep file reads bounded for large libraries; do not mix results from another project.
        const readable = books.filter(book => !book.error);
        for (let index = 0; index < readable.length; index += 4) {
          const results = await Promise.allSettled(readable.slice(index, index + 4).map(book => window.writer.readWorldBook(projectId, book.name)));
          if (!live) return;
          results.forEach((result, offset) => result.status === 'fulfilled' ? loaded.push(result.value) : problems.push(`${readable[index + offset]!.name}：读取失败`));
        }
        if (live) { setWorlds(loaded); setErrors(problems); }
      }
    })().catch(error => { if (live) setErrors([String(error instanceof Error ? error.message : error)]); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [projectId, kind, revision, reload]);

  const count = kind === 'characters' ? characters?.value.cards.length ?? 0 : worlds.reduce((sum, book) => sum + book.entries.length, 0);
  return <section className="inspector-cards" aria-busy={loading} aria-label={kind === 'characters' ? '本书人物卡' : '本书世界设定卡'}>
    <div className="inspector-cards-heading"><strong>{kind === 'characters' ? '人物卡' : '世界设定卡'} <span>{loading ? '…' : count}</span></strong><button type="button" onClick={() => { setLoading(true); setReload(value => value + 1); }} disabled={loading || acting}>刷新</button></div>
    {actionError && <p className="inspector-card-error" role="alert">{actionError}</p>}{message && <p className="inspector-card-empty" role="status">{message}</p>}
    {kind === 'world' && worldDraft && <div className="inspector-draft" role="status"><strong>有未保存的设定卡草稿</strong><p>{worldDraft.target.comment || worldDraft.target.entryId} · {worldDraft.target.book}</p><button disabled={acting} onClick={() => onEditWorld(worldDraft.target)}>查看并恢复草稿</button> <button disabled={acting} onClick={() => { if (!window.confirm('确定放弃这份未保存的设定卡草稿？已保存的世界书不会改变。')) return; void act(async () => { await window.writer.clearUiDraft(projectId, 'world-card'); setWorldDraft(null); setMessage('已放弃未保存草稿。'); }); }}>放弃草稿</button></div>}
    {kind === 'world' && draftError && <p className="inspector-card-error" role="alert">设定卡草稿无法读取，原文件已保留；为避免覆盖，暂不能编辑其他设定卡。{draftError}</p>}
    {loading && <p className="inspector-card-empty">正在读取本书卡片…</p>}
    {!loading && !count && !errors.length && <p className="inspector-card-empty">还没有{kind === 'characters' ? '人物' : '世界设定'}卡片，可从下方入口创建或整理。</p>}
    {errors.map((error, index) => <p className="inspector-card-error" role="alert" key={`${index}:${error}`}>卡片读取失败：{error}</p>)}
    {count > 0 && <div className="inspector-card-list">
      {kind === 'characters' && characters?.value.cards.map(card => <details className="inspector-card" key={card.id}>
        <summary><span className="inspector-card-avatar">{characters.portraits[card.portrait] ? <img src={characters.portraits[card.portrait]} alt="" /> : card.name.slice(0, 1)}</span><span className="inspector-card-title"><strong>{card.name}</strong><small>{card.enabled ? '已启用' : '未启用'}</small></span></summary>
        <div className="inspector-card-body">{([['角色描述', card.description], ['性格', card.personality], ['背景', card.scenario], ['示例对话', card.examples]] as const).filter(([, value]) => value.trim()).map(([label, value]) => <div key={label}><b>{label}</b><p>{value}</p></div>)}{![card.description, card.personality, card.scenario, card.examples].some(value => value.trim()) && <p>暂无文字资料。</p>}</div>
      </details>)}
      {kind === 'world' && worlds.flatMap(book => book.entries.map(entry => <details className="inspector-card" data-book-hash={book.hash} key={`${book.name}:${entry.id}`}>
        <summary><span className="inspector-card-symbol" aria-hidden="true">◇</span><span className="inspector-card-title"><strong>{entry.comment || entry.keys[0] || `未命名条目 ${entry.id}`}</strong><small>{book.name} · {entry.disabled ? '已停用' : entry.constant ? '常驻' : '关键词触发'}</small></span></summary>
        <div className="inspector-card-body"><p>{entry.content || '暂无设定内容。'}</p><small>关键词：{entry.keys.join('、') || '无'}</small><button type="button" disabled={acting || Boolean(worldDraft) || Boolean(draftError)} title={worldDraft ? '请先处理本书未保存的设定卡草稿' : draftError ? '请先检查本机草稿' : undefined} onClick={() => onEditWorld({ projectId, book: book.name, entryId: entry.id, expectedHash: book.hash, comment: entry.comment || entry.keys[0] || `未命名条目 ${entry.id}`, content: entry.content, keys: entry.keys })}>编辑设定卡</button> <button type="button" disabled={acting} onClick={() => onOpenWorld(book.name)}>打开所在世界书</button> <button type="button" className="inspector-card-delete" disabled={acting} onClick={() => { if (!window.confirm(`删除设定卡「${entry.comment || entry.keys[0] || entry.id}」？将先备份，可从回收站恢复。${book.container === 'array' ? '此世界书使用数组，删除后后续条目的编号会移动，依赖编号的扩展可能受影响；如条目再被修改，需先核对备份。' : ''}`)) return; void act(async () => { await window.writer.deleteWorldEntry({ projectId, book: book.name, entryId: entry.id, expectedHash: book.hash }); setReload(value => value + 1); setMessage('设定卡已删除并备份，可从回收站恢复。'); if (trashOpen) { try { setTrash(await window.writer.listWorldEntryTrash(projectId)); } catch { setActionError('设定卡已删除，但回收站列表刷新失败，请稍后重新打开。'); } } }); }}>删除设定卡</button></div>
      </details>))}
    </div>}
    {kind === 'world' && <div className="inspector-trash"><button type="button" disabled={acting || loading} aria-expanded={trashOpen} onClick={() => { if (trashOpen) { setTrashOpen(false); return; } void act(async () => { setTrash(await window.writer.listWorldEntryTrash(projectId)); setTrashOpen(true); }); }}>设定卡回收站…</button>
      {trashOpen && trash && <div><p>备份保留在本书文件夹。对象条目同 ID 存在时不会覆盖；数组条目变化后不能原位恢复，可选择追加为末尾新卡。追加不会自动判断语义重复，请核对。失败操作也可能留下可核对的备份。</p>{trash.errors.length > 0 && <p className="inspector-card-error" role="alert">{trash.errors.length} 条备份无法读取，原文件已保留。</p>}{!trash.items.length && <p>暂无备份。</p>}
        {trash.items.map(item => { const book = worlds.find(world => world.name === item.book); const occupied = item.container === 'object' && (book?.entries.some(entry => entry.id === item.entryId) ?? false); return <article key={item.id} className="inspector-trash-item"><strong>{item.name}</strong><small>{item.book} · {new Date(item.removedAt).toLocaleString()}</small><button type="button" disabled={acting || loading} aria-expanded={trashPreview?.id === item.id} onClick={() => { if (trashPreview?.id === item.id) { setTrashPreview(null); return; } void act(async () => setTrashPreview(await window.writer.previewWorldEntryTrash({ projectId, trashId: item.id, expectedHash: item.hash }))); }}>{trashPreview?.id === item.id ? '收起备份内容' : '查看备份内容'}</button>{trashPreview?.id === item.id && <div className="inspector-trash-preview" aria-label="回收记录内容"><strong>{trashPreview.comment || item.name}</strong><small>关键词：{trashPreview.keys.join('、') || '无'}</small><pre>{trashPreview.content || '暂无文字内容'}</pre><small>仅展示常用字段；原始备份中的其他扩展仍保留。</small></div>}<button type="button" disabled={acting || loading || !book || occupied} title={!book ? '原世界书不存在或读取失败' : occupied ? '原位置已有同 ID 条目' : '恢复此条目，不覆盖其他条目'} onClick={() => { if (!window.confirm(`恢复「${item.name}」到世界书「${item.book}」？其他条目不会回滚。${item.container === 'array' ? '将核对删除后的数组条目，若期间发生变化则不会自动恢复。' : ''}`)) return; void act(async () => { const latest = await window.writer.readWorldBook(projectId, item.book); await window.writer.restoreWorldEntry({ projectId, trashId: item.id, expectedHash: latest.hash }); setReload(value => value + 1); setMessage(`已恢复「${item.name}」，备份保留。`); }); }}>{occupied ? '原位置已有条目' : !book ? '原世界书不可用' : '恢复设定卡'}</button><button type="button" disabled={acting || loading || !book || !book.entries.length} onClick={() => { if (book) { setActionError(''); setMergeTarget({ book, item }); } }}>比较并合并到现有卡…</button>{item.container === 'array' && <button type="button" disabled={acting || loading || !book} onClick={() => { if (!window.confirm(`将「${item.name}」作为新卡追加到「${item.book}」末尾？现有条目不会回滚，但编号和原位置可能不同；请核对依赖编号的扩展及重复设定。`)) return; void act(async () => { const latest = await window.writer.readWorldBook(projectId, item.book); await window.writer.restoreWorldEntry({ projectId, trashId: item.id, expectedHash: latest.hash, mode: 'append' }); setReload(value => value + 1); setMessage(`已将「${item.name}」追加为末尾设定卡，备份保留。`); }); }}>追加为末尾新卡…</button>}<button type="button" disabled={acting || loading} onClick={() => { if (!window.confirm(`永久清理「${item.name}」的这条回收记录？清理后不能再从此记录恢复；世界书和其他备份不会被删除。`)) return; void act(async () => { await window.writer.purgeWorldEntryTrash({ projectId, trashId: item.id, expectedHash: item.hash }); setTrash(current => current ? { ...current, items: current.items.filter(record => record.id !== item.id) } : current); setTrashPreview(current => current?.id === item.id ? null : current); setMessage(`已清理「${item.name}」的回收记录，世界书和其他备份保留。`); }); }}>永久清理回收记录…</button></article>; })}
      </div>}
    </div>}
    {mergeTarget && <WorldTrashMerge projectId={projectId} book={mergeTarget.book} item={mergeTarget.item} onBusy={onBusy} onClose={() => setMergeTarget(null)} onSaved={name => { setMergeTarget(null); setReload(value => value + 1); setMessage(`已合并「${name}」的所选字段，原世界书和回收备份保留。`); }} />}
  </section>;
}
