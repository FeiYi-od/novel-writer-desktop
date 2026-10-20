import { useEffect, useRef, useState } from 'react';
import type { CharacterCard, CharacterEdit, CharacterFields, CharacterSnapshot } from '../../shared/contracts';
import { characterContext, emptyCharacter } from '../../core/characters';

const labels: [Exclude<keyof CharacterFields, 'alternateGreetings'>, string][] = [
  ['name', '角色名称'], ['description', '角色描述'], ['personality', '性格与行为边界'], ['scenario', '角色背景'],
  ['firstMessage', '开场白'], ['examples', '示例对话'], ['creatorNotes', '作者说明'], ['systemPrompt', '卡内系统提示'], ['postHistoryInstructions', '后置提示']
];
type Draft = { edit: CharacterEdit; hash: string; image: string; warnings: string[]; format: string };

export function Characters({ projectId, title, legacyNotes, onDirty }: { projectId: string; title: string; legacyNotes: string; onDirty: (dirty: boolean) => void }) {
  const [snapshot, setSnapshot] = useState<CharacterSnapshot | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [search, setSearch] = useState('');
  const [restored, setRestored] = useState(false);
  const [notice, setNotice] = useState('');
  const [merging, setMerging] = useState<string | null>(null);
  const pending = useRef(false); const tokens = useRef(new Set<string>());
  useEffect(() => { let live = true; void window.writer.readCharacters(projectId).then(value => { if (live) setSnapshot(value); }).catch(e => { if (live) setError(String(e)); }); return () => { live = false; for (const token of tokens.current) void window.writer.releaseCharacterImport(projectId, token); }; }, [projectId]);
  useEffect(() => { onDirty(Boolean(draft) || busy); return () => onDirty(false); }, [draft, busy, onDirty]);
  // Editing state survives an exit; it never edits the project until the author saves.
  const draftLoaded = useRef(false);
  useEffect(() => {
    let live = true;
    void window.writer.readUiDraft(projectId, 'characters').then(value => {
      if (!live) return;
      draftLoaded.current = true;
      const text = value?.values.draft; if (!text) return;
      try { const parsed = JSON.parse(text) as Draft; if (parsed?.edit?.fields) { setDraft(parsed); setRestored(true); } }
      catch { /* keep the file; never adopt unreadable input automatically */ }
    }).catch(() => { draftLoaded.current = true; });
    return () => { live = false; };
  }, [projectId]);
  useEffect(() => {
    if (!draftLoaded.current) return;
    if (!draft) { void window.writer.clearUiDraft(projectId, 'characters').catch(() => {}); return; }
    const timer = setTimeout(() => { void window.writer.saveUiDraft(projectId, 'characters', { draft: JSON.stringify(draft) }).catch(() => {}); }, 800);
    return () => clearTimeout(timer);
  }, [draft, projectId]);
  async function action(fn: () => Promise<void>) {
    if (pending.current) return; pending.current = true; setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(String(e)); } finally { pending.current = false; setBusy(false); }
  }
  async function importCard(kind: 'image' | 'text') {
    if (!snapshot) return;
    const next = await window.writer.previewCharacter(projectId, kind);
    if (next) { tokens.current.add(next.token); setDraft({ edit: { fields: next.fields, enabled: false, importToken: next.token }, hash: snapshot.hash, image: next.image, warnings: next.warnings, format: next.format }); }
  }
  function editCard(card: CharacterCard) {
    const fields = emptyCharacter();
    for (const key of Object.keys(fields) as (keyof CharacterFields)[]) Object.assign(fields, { [key]: structuredClone(card[key]) });
    setDraft({ edit: { id: card.id, fields, enabled: card.enabled }, hash: snapshot!.hash, image: snapshot!.portraits[card.portrait] ?? '', warnings: card.warnings, format: card.source.format });
  }
  async function releaseDraft() {
    for (const token of tokens.current) await window.writer.releaseCharacterImport(projectId, token);
    tokens.current.clear(); setDraft(null);
  }
  const cards = snapshot?.value.cards ?? [];
  const context = characterContext(projectId, cards);
  return <section className="characters-page">
    <div className="page-title"><div><span className="eyebrow">CHARACTER LIBRARY</span><h1>角色库<span>{title}</span></h1><p>图片卡与文字卡统一管理，多位角色可同时用于本书。</p></div><span className="studio-badge">{cards.length} 位角色 · {context.length} 位启用</span></div>
    {error && <div role="alert" className="error">{error}</div>}
    <div className="character-toolbar"><input aria-label="搜索角色" placeholder="搜索角色名称…" value={search} onChange={e => setSearch(e.target.value)} /><div className="actions">
      <button disabled={busy} onClick={() => void action(async () => setSnapshot(await window.writer.readCharacters(projectId)))}>重新载入角色库</button>
      <button disabled={busy || !snapshot} onClick={() => void action(() => importCard('image'))}>导入图片角色卡</button>
      <button disabled={busy || !snapshot} onClick={() => void action(() => importCard('text'))}>导入文字角色卡</button>
      <button className="primary" disabled={busy || !snapshot} onClick={() => setDraft({ edit: { fields: emptyCharacter(), enabled: false }, hash: snapshot!.hash, image: '', warnings: [], format: '文字' })}>＋ 新建文字角色卡</button>
    </div></div>
    <p className="character-help">PNG 可读取酒馆内嵌卡片；JSON、TXT、DOCX 可导入文字。普通图片仅作头像，也能为文字卡添加头像。</p>
    {legacyNotes && <details className="legacy-style-note"><summary>原人物笔记（已保留）</summary><p>{legacyNotes}</p></details>}
    <div className="character-grid">{cards.filter(card => card.name.includes(search.trim())).map(card => <article className={`character-card ${card.enabled ? 'enabled' : ''}`} key={card.id}>
      <div className="character-portrait">{snapshot?.portraits[card.portrait] ? <img src={snapshot.portraits[card.portrait]} alt={`${card.name}头像`} /> : <span>{card.name.slice(0, 1)}</span>}</div>
      <div className="character-info"><small>{card.source.format} · {card.portrait ? '带头像' : '文字卡'}</small><h2>{card.name}</h2><p>{card.description || card.personality || '尚未填写角色描述'}</p><footer><label><input type="checkbox" aria-label={`启用角色 ${card.name}`} checked={card.enabled} disabled={busy} onChange={e => { const enabled = e.target.checked; void action(async () => { setSnapshot(await window.writer.saveCharacter(projectId, { id: card.id, fields: card, enabled }, snapshot!.hash)); }); }} />用于本书</label><button disabled={busy} onClick={() => editCard(card)}>查看与编辑</button><button data-testid="card-export" disabled={busy} title="导出为 SillyTavern 可直接打开的 PNG 名片" onClick={() => void action(async () => { const result = await window.writer.exportCharacterCard(projectId, card.id); setNotice(`已导出 ${result.relative}（V${result.specVersion}，${result.bytes} 字节）`); })}>导出名片</button><button data-testid="card-merge" disabled={busy || cards.length < 2} title="把这张卡合并进另一张：空字段补齐、问候语合并，操作前先备份" onClick={() => setMerging(card.id)}>合并到…</button><button data-testid="card-remove" disabled={busy} title="删除前会把当前角色库备份到本书资料" onClick={() => void action(async () => { const result = await window.writer.removeCharacterCard(projectId, card.id, snapshot!.hash); setSnapshot(result.snapshot); setNotice(`已删除「${result.removed}」，备份：${result.backup}`); })}>删除（先备份）</button></footer></div>
    </article>)}</div>
    {snapshot && !cards.length && <div className="empty-library"><b>让故事中的人物在这里相遇</b><p>导入一张图片卡，或从文字设定开始。</p></div>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {merging && snapshot && <div className="modal-overlay"><section className="book-modal merge-modal" role="dialog" aria-modal="true" aria-label="合并角色卡">
      <h2>合并角色卡</h2>
      <p>当前卡片：<b>{snapshot.value.cards.find(card => card.id === merging)?.name}</b>。合并后本卡会被并入选中的卡片并删除，**合并前会先备份整份角色库**。</p>
      <ul className="merge-targets">{snapshot.value.cards.filter(card => card.id !== merging).map(card => <li key={card.id}>
        <button data-testid="merge-into" disabled={busy} onClick={() => void action(async () => { const result = await window.writer.mergeCharacterCards(projectId, card.id, merging, snapshot.hash); setSnapshot(result.snapshot); setNotice(`已合并「${result.dropped}」→「${result.mergedInto}」，备份：${result.backup}`); setMerging(null); })}>合并进「{card.name}」</button>
      </li>)}</ul>
      <footer><button disabled={busy} onClick={() => setMerging(null)}>取消</button></footer>
    </section></div>}
    <details className="character-context"><summary>本书角色上下文预览（{context.length} 位）</summary><pre>{context.map(item => item.text).join('\n\n') || '在角色卡上勾选“用于本书”，即可同时选择图片卡和文字卡。'}</pre><p>AI 请求仅包含启用角色的名称、描述、性格与背景；开场白、作者说明和扩展不会自动变成正文。</p></details>
    {draft && <div className="modal-overlay"><section className="character-modal" role="dialog" aria-modal="true" aria-label="角色卡编辑">
      <header><div><span className="eyebrow">{draft.edit.importToken ? 'IMPORT PREVIEW' : 'CHARACTER DETAILS'}</span><h2>{draft.edit.importToken ? '确认导入角色卡' : draft.edit.id ? '编辑角色卡' : '新建文字角色卡'}</h2></div><span>归属：{title}</span></header>
      <div className="character-form"><aside><div className="character-portrait large">{draft.image ? <img src={draft.image} alt="角色卡预览" /> : <span>人</span>}</div><button disabled={busy} onClick={() => void action(async () => {
        const portrait = await window.writer.chooseCharacterPortrait(projectId);
        if (portrait) { if (draft.edit.portraitToken) { await window.writer.releaseCharacterImport(projectId, draft.edit.portraitToken); tokens.current.delete(draft.edit.portraitToken); } tokens.current.add(portrait.token); setDraft({ ...draft, image: portrait.image, edit: { ...draft.edit, portraitToken: portrait.token, removePortrait: false } }); }
      })}>选择角色头像</button><button disabled={busy || !draft.image} onClick={() => setDraft({ ...draft, image: '', edit: { ...draft.edit, removePortrait: true } })}>移除头像</button><p>{draft.format} · 角色资料</p><label><input type="checkbox" checked={draft.edit.enabled} disabled={busy} onChange={e => setDraft({ ...draft, edit: { ...draft.edit, enabled: e.target.checked } })} />确认用于本书</label><small>导入默认不启用。可与本书其他图片卡、文字卡一起勾选使用。</small></aside>
      <div className="character-fields"><p className="notice">{draft.edit.importToken ? '确认后会新增独立角色，不覆盖同名角色；原卡片与未知扩展一并保存。' : '编辑基础字段不会改写原卡片文件。'}</p>
        {restored && <p className="notice" role="status">已恢复上次未保存的角色编辑，保存后才会写入角色库。<button disabled={busy} onClick={() => void action(releaseDraft)}>放弃这次编辑</button></p>}
        {draft.warnings.map((warning, i) => <p className="notice" key={i}>{warning}</p>)}
        {labels.map(([key, label]) => <label key={key}>{label}{key === 'name' ? <input aria-label={label} maxLength={200} disabled={busy} value={draft.edit.fields[key]} onChange={e => setDraft({ ...draft, edit: { ...draft.edit, fields: { ...draft.edit.fields, [key]: e.target.value } } })} /> : <textarea aria-label={label} maxLength={100000} disabled={busy} value={draft.edit.fields[key]} onChange={e => setDraft({ ...draft, edit: { ...draft.edit, fields: { ...draft.edit.fields, [key]: e.target.value } } })} />}</label>)}
        {!!draft.edit.fields.alternateGreetings.length && <details><summary>候选开场白（{draft.edit.fields.alternateGreetings.length} 条，原样保留）</summary>{draft.edit.fields.alternateGreetings.map((text, i) => <pre key={i}>{text}</pre>)}</details>}
      </div></div>
      {error && <div role="alert" className="error">{error}</div>}
      <footer><button disabled={busy} onClick={() => { if (window.confirm('关闭并放弃当前角色编辑？')) void action(releaseDraft); }}>取消</button><button className="primary" disabled={busy || !draft.edit.fields.name.trim()} onClick={() => void action(async () => { const next = await window.writer.saveCharacter(projectId, draft.edit, draft.hash); setSnapshot(next); await releaseDraft(); })}>{busy ? '保存中…' : draft.edit.importToken ? '确认导入' : '保存角色卡'}</button></footer>
    </section></div>}
  </section>;
}
