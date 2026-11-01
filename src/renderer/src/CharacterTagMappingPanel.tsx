import { useEffect, useRef, useState } from 'react';
import type { CharacterCard, CharacterTagMapping, CharacterTagMappingSnapshot } from '../../shared/contracts';

type Row = { card: CharacterCard; selected: boolean; avatarKey: string; knownTags: boolean; tags: string };

/** The author explicitly confirms identifiers; names or card tags are never inferred as IDs. */
export function CharacterTagMappingPanel({ projectId, onClose, onDirty, onBusy }: { projectId: string; onClose: () => void; onDirty: (dirty: boolean) => void; onBusy: (busy: boolean) => void }) {
  const [snapshot, setSnapshot] = useState<CharacterTagMappingSnapshot | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const live = useRef(true);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    live.current = true;
    const previous = document.activeElement;
    panel.current?.focus();
    return () => { live.current = false; onDirty(false); onBusy(false); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [onDirty, onBusy]);
  const working = (value: boolean) => { setBusy(value); onBusy(value); };
  const load = async () => {
    const [mapping, cards] = await Promise.all([window.writer.readCharacterTagMappings(projectId), window.writer.readCharacters(projectId)]);
    if (mapping.projectId !== projectId || cards.value.projectId !== projectId || cards.hash !== mapping.currentCharacterHash || cards.value.cards.some(card => card.projectId !== projectId)) throw new Error('角色资料已变化或归属不符，请重新打开');
    if (!live.current) return;
    const byId = new Map(mapping.mappings.map(item => [item.characterId, item]));
    setSnapshot(mapping);
    setRows(cards.value.cards.map(card => { const item = byId.get(card.id); return { card, selected: !!item, avatarKey: item?.avatarKey ?? '', knownTags: item?.tagIds !== null && item !== undefined, tags: item?.tagIds?.join('\n') ?? '' }; }));
    setDirty(false); onDirty(false);
  };
  useEffect(() => { working(true); void load().catch(e => { if (live.current) setError(String(e instanceof Error ? e.message : e)); }).finally(() => { if (live.current) working(false); }); }, [projectId]);
  const update = (id: string, change: Partial<Row>) => { setRows(current => current.map(row => row.card.id === id ? { ...row, ...change } : row)); setDirty(true); onDirty(true); setMessage(''); };
  const save = async () => {
    if (!snapshot || busy) return;
    working(true); setError(''); setMessage('');
    try {
      const mappings: CharacterTagMapping[] = rows.filter(row => row.selected).map(row => ({ characterId: row.card.id, avatarKey: row.avatarKey.trim(), tagIds: row.knownTags ? row.tags.split(/\r?\n/u).map(value => value.trim()).filter(Boolean) : null }));
      const saved = await window.writer.saveCharacterTagMappings(projectId, mappings, snapshot.hash, snapshot.currentCharacterHash);
      if (!live.current) return;
      if (saved.projectId !== projectId || saved.stale) throw new Error('保存结果无法确认，请重新核对');
      setSnapshot(saved); setDirty(false); onDirty(false); setMessage('关联已确认并保存到本书。');
    } catch (e) { if (live.current) setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); }
    finally { if (live.current) working(false); }
  };
  const close = () => { if (busy) return; if (dirty) { setError('关联有未保存修改，请先保存或放弃修改。'); return; } onClose(); };
  return <div className="modal-overlay"><section ref={panel} tabIndex={-1} className="book-modal world-modal" role="dialog" aria-modal="true" aria-label="酒馆角色关联" onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); close(); }
    if (event.key === 'Tab') {
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)'));
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus(); }
    }
  }}>
    <header><div><h2>酒馆角色关联</h2><p>为每个角色手动填写酒馆的头像文件标识和标签 ID。角色卡标签文字不会自动当成 ID；只保存作者明确确认的关联。</p></div></header>
    {snapshot?.stale && <p className="notice">角色卡已改变，旧关联暂不用于写作。请核对后重新保存；已移除的角色不会被重新保存。</p>}
    {error && <div role="alert" className="error">{error}</div>}{message && <p role="status">{message}</p>}
    {!snapshot && !error && <p>正在读取角色与关联…</p>}
    {snapshot && !rows.length && <p>本书还没有角色卡，请先创建角色。</p>}
    {rows.map(row => <article className="tag-mapping-row" key={row.card.id}>
      <label className="ai-check"><input type="checkbox" checked={row.selected} disabled={busy} onChange={event => update(row.card.id, { selected: event.target.checked })} />{row.card.name || '未命名角色'}{row.card.enabled ? '' : '（未启用）'}</label>
      {row.selected && <>
        <label>酒馆头像标识<input aria-label={`${row.card.name} 酒馆头像标识`} value={row.avatarKey} maxLength={256} disabled={busy} onChange={event => update(row.card.id, { avatarKey: event.target.value })} placeholder="酒馆角色头像文件名，不含扩展名" /></label>
        <label className="ai-check"><input type="checkbox" checked={row.knownTags} disabled={busy} onChange={event => update(row.card.id, { knownTags: event.target.checked })} />已确认该角色的酒馆标签 ID</label>
        {row.knownTags && <label>每行一个 ID；留空表示确认没有标签<textarea aria-label={`${row.card.name} 标签 ID`} rows={3} maxLength={15000} disabled={busy} value={row.tags} onChange={event => update(row.card.id, { tags: event.target.value })} /></label>}
      </>}
    </article>)}
    <footer className="actions"><button className="primary" disabled={busy || !snapshot || (!dirty && !snapshot.stale)} onClick={() => void save()}>确认并保存</button><button disabled={busy || !dirty} onClick={() => { working(true); setError(''); void load().catch(e => { if (live.current) setError(String(e)); }).finally(() => { if (live.current) working(false); }); }}>放弃修改</button><button disabled={busy} onClick={close}>关闭</button></footer>
  </section></div>;
}
