import { useEffect, useState } from 'react';
import type { AIConnection, BookDetails, BookSnapshot, LearnedStyle } from '../../shared/contracts';
import { selectedStylePrompt } from '../../core/style-analysis';
import { AIStyleLearning } from './AIStyleLearning';

export function StyleStudio({ snapshot, onUpdate, onSave, onDirty, legacyNotes, connections }: {
  snapshot: BookSnapshot; onUpdate: (next: BookSnapshot) => void;
  legacyNotes: string; connections: AIConnection[];
  onSave: (id: string, value: BookDetails, hash: string) => Promise<BookSnapshot>; onDirty: (dirty: boolean) => void;
}) {
  const book = snapshot.value;
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [learningDirty, setLearningDirty] = useState(false);
  const [editing, setEditing] = useState<LearnedStyle | null>(null);
  useEffect(() => { onDirty(Boolean(editing) || learningDirty || busy); return () => onDirty(false); }, [editing, learningDirty, busy, onDirty]);
  // 文风一旦变化（新建/学习/改规则）就同步一次版本库：新建时记下第 1 版，改规则时把旧版压入历史。
  const styleSignature = book.styles.map(style => style.id + ':' + style.rules).join('|');
  useEffect(() => { void window.writer.syncStyleHistory(book.projectId).catch(() => {}); }, [book.projectId, styleSignature]);
  useEffect(() => { const prevent = (e: BeforeUnloadEvent) => { if (busy) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent); }, [busy]);
  async function action(fn: () => Promise<void>) { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(String(e)); } finally { setBusy(false); } }
  return <section className="style-page">
    <div className="page-title"><div><span className="eyebrow">STYLE STUDIO</span><h1>文风研习室<span>{book.title}</span></h1><p>从参考文本提炼表达习惯，整理成你自己的文风工具箱。</p></div><span className="studio-badge">本地统计 / 可选模型分析</span></div>
    {error && <div className="error" role="alert">{error}</div>}
    {legacyNotes && <details className="legacy-style-note"><summary>原文风笔记（已保留）</summary><p>{legacyNotes}</p></details>}
    <div className="studio-layout"><div className="source-panel"><div className="panel-heading"><h2>01 / 参考文本</h2><button disabled={busy} onClick={() => void action(async () => { const next = await window.writer.importStyleSources(book.projectId, snapshot.hash); if (next) onUpdate(next); })}>＋ 导入文本</button></div><p>支持 TXT、DOCX。语料按小说保存，不会加入人物或世界观。</p>
      <div className="source-list">{book.sources.map(source => <label key={source.id}><input type="checkbox" disabled={busy} checked={selectedSources.includes(source.id)} onChange={e => setSelectedSources(current => e.target.checked ? [...current, source.id] : current.filter(id => id !== source.id))} /><span>{source.name}<small>{source.characters.toLocaleString()} 字</small></span></label>)}{!book.sources.length && <div className="source-empty">导入一段喜欢的小说文本<br/><small>从对白、句式与段落节奏开始</small></div>}</div>
      <div className="analyze-form"><h2>02 / 提炼文风</h2><label>文风名称<input placeholder="例如：轻快日常、冷静悬疑" value={name} maxLength={100} disabled={busy} onChange={e => setName(e.target.value)} /></label><button className="primary" disabled={busy || !name.trim() || !selectedSources.length} onClick={() => void action(async () => {
        const next = await window.writer.analyzeStyle(book.projectId, name, selectedSources, snapshot.hash); onUpdate(next); setName('');
      })}>{busy ? '处理中…' : '分析并生成文风'}</button><small>分析句长、段长及引号内文本比例，生成可编辑规则；模型分析入口见下方；不执行模型微调。</small></div>
    </div><div className="style-library"><div className="panel-heading"><h2>03 / 我的文风</h2><span>{book.styles.length} 个档案</span></div>
    {!book.styles.length && <div className="style-empty"><div>风</div><h3>让表达拥有不同的气质</h3><p>选择参考文本并命名，即可生成文风档案。<br/>为日常、战斗、心理描写保留不同版本。</p></div>}
    <div className="style-cards">{book.styles.map(style => <article key={style.id} className={`style-card ${book.activeStyleId === style.id ? 'chosen' : ''}`}><header><h3>{style.name}</h3>{book.activeStyleId === style.id && <span className="badge">本书使用中</span>}</header><div className="style-metrics"><span>句均 <b>{style.metrics.meanSentenceLength}</b> 字</span><span>段均 <b>{style.metrics.meanParagraphLength}</b> 字</span><span>引号内 <b>{style.metrics.dialogueRatio}%</b></span></div><p>{style.rules}</p><footer><small>{style.sourceIds.length} 份语料 · {style.method === 'model-analysis-v1' ? `模型分析：${style.analysis?.model ?? '未记录'}` : '本地特征分析'}</small><div><button disabled={busy} onClick={() => { if (!editing || window.confirm('放弃当前未保存的文风修改？')) setEditing(structuredClone(style)); }}>编辑规则</button><button className="primary" disabled={busy || book.activeStyleId === style.id} onClick={() => void action(async () => { await onSave(book.projectId, { ...book, activeStyleId: style.id }, snapshot.hash); })}>用于本书</button></div></footer></article>)}</div>
    </div></div>
    <AIStyleLearning key={book.projectId} snapshot={snapshot} sourceIds={selectedSources} name={name} connections={connections} blocked={busy || Boolean(editing)} onUpdate={onUpdate} onDirty={setLearningDirty} />
    {editing && <div className="modal-overlay"><section className="style-edit-modal" role="dialog" aria-modal="true" aria-label="编辑文风规则"><h2>编辑文风规则</h2><label>名称<input value={editing.name} maxLength={100} onChange={e => setEditing({ ...editing, name: e.target.value })} /></label><label>写作规则<textarea value={editing.rules} maxLength={20000} onChange={e => setEditing({ ...editing, rules: e.target.value })} /></label>{error && <div className="error">{error}</div>}<div className="actions"><button disabled={busy} onClick={() => { if (window.confirm('放弃未保存的文风修改？')) setEditing(null); }}>取消</button><button className="primary" disabled={busy || !editing.name.trim() || !editing.rules.trim()} onClick={() => void action(async () => { await onSave(book.projectId, { ...book, styles: book.styles.map(s => s.id === editing.id ? editing : s) }, snapshot.hash); await window.writer.syncStyleHistory(book.projectId).catch(() => {}); setEditing(null); })}>保存文风</button></div></section></div>}
  </section>;
}

export function StylePicker({ snapshot, disabled, onSelect, onOpenStudio }: { snapshot: BookSnapshot; disabled: boolean; onSelect: (id: string) => void; onOpenStudio: () => void }) {
  const book = snapshot.value; const prompt = selectedStylePrompt(book, book.projectId);
  return <div className="style-picker"><label>辅助创作文风<select aria-label="辅助创作文风" value={book.activeStyleId} disabled={disabled} onChange={e => onSelect(e.target.value)}><option value="">不指定文风</option>{book.styles.map(style => <option value={style.id} key={style.id}>{style.name}</option>)}</select></label><button onClick={onOpenStudio}>前往文风研习室 →</button>{prompt && <details><summary>查看文风提示词</summary><pre>{prompt}</pre></details>}<p>已选择的规则保存在本书配置中，并用于后续 AI 写作与审稿请求。</p></div>;
}
