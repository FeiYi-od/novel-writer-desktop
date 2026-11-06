import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { WorldCardEditRequest } from '../../shared/contracts';
import { parseWorldCardDraft, worldCardDraftPayload, type WorldCardDraft } from '../../core/world-card-draft';

export function WorldCardEditor({ target, onClose, onSaved }: { target: WorldCardEditRequest; onClose: () => void; onSaved: (projectId: string, book: string, cleanupError?: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const [name, setName] = useState(target.comment);
  const [content, setContent] = useState(target.content);
  const [keys, setKeys] = useState(target.keys.join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [phase, setPhase] = useState<'loading' | 'ready' | 'recover' | 'foreign' | 'broken'>('loading');
  const [saved, setSaved] = useState<WorldCardDraft | null>(null);
  const [checkpoint, setCheckpoint] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ownsDraft = useRef(false);
  const revision = useRef(0);
  const changed = name !== target.comment || content !== target.content || keys !== target.keys.join('\n');
  useLayoutEffect(() => { const node = dialog.current; node?.showModal(); return () => { if (node?.open) node.close(); }; }, []);
  useEffect(() => {
    let live = true;
    void window.writer.readUiDraft(target.projectId, 'world-card').then(value => {
      if (!live) return;
      if (!value) { setPhase('ready'); return; }
      const draft = parseWorldCardDraft(target.projectId, value);
      setSaved(draft);
      const same = draft.target.book === target.book && draft.target.entryId === target.entryId && draft.target.expectedHash === target.expectedHash;
      setPhase(same ? 'recover' : 'foreign');
    }).catch(failure => { if (live) { setError(String(failure instanceof Error ? failure.message : failure)); setPhase('broken'); } });
    return () => { live = false; };
  }, [target.projectId, target.book, target.entryId, target.expectedHash]);
  useEffect(() => {
    if (phase !== 'ready' || (!changed && !ownsDraft.current)) return;
    const current = revision.current;
    timer.current = setTimeout(() => {
      timer.current = null;
      const operation = changed ? (() => { ownsDraft.current = true; return window.writer.saveUiDraft(target.projectId, 'world-card', worldCardDraftPayload(target, name, content, keys)); })() : window.writer.clearUiDraft(target.projectId, 'world-card');
      void operation.then(() => { if (current === revision.current) { if (!changed) ownsDraft.current = false; setCheckpoint(changed ? '草稿已暂存到本机' : ''); } }).catch(failure => { if (current === revision.current) setCheckpoint('草稿暂存失败，请保留当前内容并保存或复制：' + String(failure instanceof Error ? failure.message : failure)); });
    }, 800);
    return () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  }, [phase, changed, name, content, keys, target]);
  function cancelTimer() { if (timer.current) { clearTimeout(timer.current); timer.current = null; } }
  async function close() {
    if (pending.current || phase === 'loading') return;
    if (phase !== 'ready') { onClose(); return; }
    if (changed && !window.confirm('当前设定卡有未保存修改，确定放弃吗？')) return;
    pending.current = true; setBusy(true); cancelTimer();
    try { await window.writer.clearUiDraft(target.projectId, 'world-card'); onClose(); }
    catch (failure) { setError('无法清除本机草稿，窗口和内容保留：' + String(failure instanceof Error ? failure.message : failure)); }
    finally { pending.current = false; setBusy(false); }
  }
  async function discardSaved() {
    if (pending.current || !window.confirm('确定放弃这份未保存的设定卡草稿？已保存的世界书不会改变。')) return;
    pending.current = true; setBusy(true);
    try { await window.writer.clearUiDraft(target.projectId, 'world-card'); setSaved(null); setPhase('ready'); setError(''); setCheckpoint(''); }
    catch (failure) { setError('无法清除草稿，原草稿已保留：' + String(failure instanceof Error ? failure.message : failure)); }
    finally { pending.current = false; setBusy(false); }
  }
  function trap(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Tab' || event.nativeEvent.isComposing) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')].filter(item => item.getClientRects().length > 0);
    const first = items[0], last = items.at(-1);
    if (!first || !last) { event.preventDefault(); event.currentTarget.focus(); }
    else if (event.shiftKey && (document.activeElement === first || !event.currentTarget.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  async function save() {
    if (pending.current || phase !== 'ready') return;
    pending.current = true; setBusy(true); setError(''); cancelTimer();
    try {
      if (changed) { ownsDraft.current = true; await window.writer.saveUiDraft(target.projectId, 'world-card', worldCardDraftPayload(target, name, content, keys)); }
      const keyList = keys.split(/\r?\n/u).map(key => key.trim()).filter(Boolean);
      await window.writer.saveWorldEntry({ ...target, comment: name, content, keys: keyList });
      let cleanupError = '';
      try { await window.writer.clearUiDraft(target.projectId, 'world-card'); } catch (failure) { cleanupError = String(failure instanceof Error ? failure.message : failure); }
      onSaved(target.projectId, target.book, cleanupError);
    } catch (failure) { setError(String(failure instanceof Error ? failure.message : failure).replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '')); }
    finally { pending.current = false; setBusy(false); }
  }
  return <dialog ref={dialog} className="modal-overlay character-native-dialog" aria-label="编辑世界设定卡" onCancel={event => { event.preventDefault(); void close(); }} onKeyDown={trap}>
    <section className="book-modal world-card-editor">
      <header><div><h2>编辑世界设定卡</h2><p>所属世界书：{target.book}。保存前会核对版本并备份原世界书。</p></div></header>
      {phase === 'loading' && <p role="status">正在检查本机草稿…</p>}
      {phase === 'recover' && saved && <div className="notice" role="status">发现上次未保存的设定卡草稿，恢复后请核对；若世界书已变化，保存会拒绝覆盖。<div className="actions"><button disabled={busy} onClick={() => { revision.current++; ownsDraft.current = true; setName(saved.name); setContent(saved.content); setKeys(saved.keys); setPhase('ready'); setCheckpoint('已恢复本机草稿，请核对后保存'); }}>恢复上次草稿</button><button disabled={busy} onClick={() => void discardSaved()}>放弃上次草稿</button></div></div>}
      {phase === 'foreign' && <p role="alert">本书已有另一张卡片的未保存草稿，请关闭本窗口，在世界观侧栏先恢复或放弃它。</p>}
      {phase === 'broken' && <p>暂不覆盖这份本机草稿，请先保留原草稿并检查。</p>}
      <label>卡片名称<input aria-label="设定卡名称" value={name} maxLength={200} disabled={busy || phase !== 'ready'} onChange={event => { revision.current++; setName(event.target.value); }} /></label>
      <label>设定内容<textarea aria-label="设定卡内容" rows={9} maxLength={100000} disabled={busy || phase !== 'ready'} value={content} onChange={event => { revision.current++; setContent(event.target.value); }} /></label>
      <label>触发关键词（每行一个）<textarea aria-label="设定卡关键词" rows={3} disabled={busy || phase !== 'ready'} value={keys} onChange={event => { revision.current++; setKeys(event.target.value); }} /></label>
      <p>修改关键词会影响写作时的世界书触发；其他酒馆字段与扩展会保留。</p>
      {checkpoint && <p role="status">{checkpoint}</p>}
      {error && <div role="alert" className="error">{error}</div>}
      <footer><button disabled={busy || phase === 'loading'} onClick={() => void close()}>取消</button><button className="primary" disabled={busy || phase !== 'ready' || !name.trim()} onClick={() => void save()}>{busy ? '保存中…' : '保存设定卡'}</button></footer>
    </section>
  </dialog>;
}
