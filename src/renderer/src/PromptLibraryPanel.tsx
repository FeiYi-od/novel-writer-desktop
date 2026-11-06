import { useEffect, useRef, useState } from 'react';
import type { PromptSnapshotView, PromptTemplateView } from '../../shared/contracts';
import { templatesFor } from '../../core/prompt-library';
import { useSaveBeforeExit } from './save-before-exit';

const kinds: { id: PromptTemplateView['kind']; label: string }[] = [{ id: 'write', label: '写作' }, { id: 'review', label: '审稿' }, { id: 'planning', label: '筹备' }, { id: 'other', label: '其他' }];
/** Named prompt templates with versions; the server owns version numbering, the panel only edits text. */
export function PromptLibraryPanel({ projectId, blocked, onDirty, onClose, onFill }: {
  projectId: string; blocked: boolean; onDirty: (value: boolean) => void; onClose: () => void; onFill: (text: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<PromptSnapshotView | null>(null);
  const [templates, setTemplates] = useState<PromptTemplateView[]>([]);
  const [name, setName] = useState(''), [kind, setKind] = useState<PromptTemplateView['kind']>('write'), [body, setBody] = useState('');
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [audit, setAudit] = useState<{ id: string; name: string; kind: string; versions: number; removedAt: string }[]>([]);
  const dialog = useRef<HTMLElement>(null);
  const dirty = !!snapshot && JSON.stringify(templates) !== JSON.stringify(snapshot.templates);
  useEffect(() => { let live = true; void window.writer.readPrompts(projectId).then(next => { if (!live) return; setSnapshot(next); setTemplates(next.templates); setSelected(next.templates[0]?.id ?? ''); }).catch(e => { if (live) setError(String(e)); }); void window.writer.promptDeletionLog(projectId).then(next => { if (live) setAudit(next.items); }).catch(() => {}); return () => { live = false; }; }, [projectId]);
  useEffect(() => { onDirty(dirty || busy); return () => onDirty(false); }, [dirty, busy, onDirty]);
  useSaveBeforeExit('提示词库', () => ({ dirty, busy, save }));
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); setMessage(''); try { await action(); } catch (e) { setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); } finally { setBusy(false); } };
  async function save() {
    if (!snapshot) throw new Error('提示词库未加载');
    // Keep the author on the same template: a brand-new template receives a server id on save,
    // so re-select it by name instead of leaving the panel pointing at a dead id.
    const keepName = templates.find(item => item.id === selected)?.name;
    const next = await window.writer.savePrompts(projectId, templates, snapshot.hash);
    setSnapshot(next); setTemplates(next.templates);
    const keep = next.templates.find(item => item.name === keepName) ?? next.templates[0];
    setSelected(keep?.id ?? '');
    onDirty(false);
    setMessage('提示词库已保存');
    void window.writer.promptDeletionLog(projectId).then(next => setAudit(next.items)).catch(() => {});
  }
  const add = () => { const clean = name.trim(); if (!clean || !body.trim()) { setError('请填写模板名称与内容'); return; } setTemplates(current => [...current, { id: `pending-${Date.now()}`, name: clean, kind, body, version: 1, updatedAt: '', versions: [] }]); setName(''); setBody(''); setError(''); };
  const current = templates.find(item => item.id === selected);
  const updateBody = (text: string) => setTemplates(current => current.map(item => item.id === selected ? { ...item, body: text } : item));
  return <div className="modal-overlay"><section ref={dialog} tabIndex={-1} className="book-modal prompts-modal" role="dialog" aria-modal="true" aria-label="提示词库" onKeyDown={event => { if (event.key === 'Escape' && !busy && !blocked) onClose(); }}>
    <header><div><h2>提示词库</h2><p>把常用提示词存成命名模板；保存时内容有改动才会升版，旧版本可回看与恢复。</p></div></header>
    {error && <div role="alert" className="error">{error}</div>}{message && <p role="status">{message}</p>}
    <div className="prompt-new">
      <label>新模板名称<input aria-label="新模板名称" maxLength={60} disabled={busy || blocked} value={name} onChange={e => setName(e.target.value)} /></label>
      <label>用途<select aria-label="模板用途" disabled={busy || blocked} value={kind} onChange={e => setKind(e.target.value as PromptTemplateView['kind'])}>{kinds.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label>内容<textarea aria-label="新模板内容" maxLength={20000} disabled={busy || blocked} value={body} onChange={e => setBody(e.target.value)} /></label>
      <button type="button" data-testid="prompt-add" disabled={busy || blocked} onClick={add}>新建模板</button>
    </div>
    <div className="prompt-layout">
      <aside><h3>已有模板</h3>{kinds.map(group => { const list = templatesFor(templates, group.id); return list.length ? <section key={group.id}><h4>{group.label}</h4><ul>{list.map(item => <li key={item.id}><button type="button" className={item.id === selected ? 'active' : ''} disabled={busy || blocked} onClick={() => setSelected(item.id)}>{item.name} <small>v{item.version}</small></button></li>)}</ul></section> : null; })}{!templates.length && <p>还没有模板。</p>}</aside>
      <article>{current ? <>
        <h3>{current.name} <small>当前 v{current.version}</small></h3>
        <textarea aria-label="模板内容" className="material-preview" maxLength={20000} disabled={busy || blocked} value={current.body} onChange={e => updateBody(e.target.value)} />
        <div className="actions">
          <button type="button" data-testid="prompt-fill" disabled={busy || blocked} onClick={() => onFill(current.body)}>填入写作要求</button>
          <button type="button" disabled={busy || blocked} onClick={() => { setTemplates(list => list.filter(item => item.id !== current.id)); setSelected(''); }}>删除模板</button>
        </div>
        {current.versions.length > 0 && <details open><summary>历史版本（{current.versions.length}）</summary><ul className="prompt-versions">{current.versions.map(version => <li key={version.version}><strong>v{version.version}</strong><pre>{version.body}</pre><button type="button" disabled={busy || blocked} onClick={() => updateBody(version.body)}>恢复这一版</button></li>)}</ul></details>}
      </> : <p>左侧选一个模板，或先新建。</p>}</article>
    </div>
    <details className="prompt-audit" data-testid="prompt-audit"><summary>删除记录（{audit.length}）</summary>{audit.length ? <ul>{audit.slice(-20).reverse().map(item => <li key={item.id + item.removedAt}>{item.name} · {item.kind} · v{item.versions} · {new Date(item.removedAt).toLocaleString('zh-CN')}</li>)}</ul> : <p>还没有删除过模板。</p>}<p><small>删除记录只用于追溯；模板内容删除后不在其中，历史版本随模板一起移除。</small></p></details>
    <footer><span>{dirty ? '有未保存改动' : '已保存'}</span><div><button disabled={busy} onClick={onClose}>关闭</button><button className="primary" data-testid="prompt-save" disabled={busy || blocked || !dirty} onClick={() => void run(save)}>保存提示词库</button></div></footer>
  </section></div>;
}
