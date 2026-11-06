import { useMemo, useState } from 'react';
import type { ChapterImportDecision, ChapterImportPlan } from '../../shared/contracts';

/** 导入预览：逐条确认章节名与顺序、排除个别文件，并选择目标分卷。 */
export function ImportPreview({ plan, volumes, busy, onCancel, onConfirm }: {
  plan: ChapterImportPlan; volumes: { id: string; title: string }[]; busy: boolean;
  onCancel: () => void;
  onConfirm: (decisions: ChapterImportDecision[], volumeId: string) => Promise<void>;
}) {
  const [names, setNames] = useState(() => Object.fromEntries(plan.items.map(item => [item.id, item.targetName])));
  const [included, setIncluded] = useState(() => Object.fromEntries(plan.items.map(item => [item.id, true])));
  const [volume, setVolume] = useState(''), [error, setError] = useState(''), [working, setWorking] = useState(false);
  const locked = busy || working;
  const chosen = useMemo(() => plan.items.filter(item => included[item.id]), [plan.items, included]);
  const duplicateNames = useMemo(() => {
    const seen = new Map<string, number>();
    for (const item of chosen) { const key = names[item.id].trim().toLowerCase(); seen.set(key, (seen.get(key) ?? 0) + 1); }
    return [...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name);
  }, [chosen, names]);
  const confirm = async () => {
    if (locked) return;
    setError(''); setWorking(true);
    try {
      await onConfirm(plan.items.map(item => ({ id: item.id, include: !!included[item.id], targetName: names[item.id] })), volume);
    } catch (failure) { setError(String(failure instanceof Error ? failure.message : failure)); }
    finally { setWorking(false); }
  };
  return <div className="modal-overlay"><section className="book-modal import-preview" role="dialog" aria-modal="true" aria-label="导入章节预览" data-testid="import-preview" style={{ width: 720, height: 'auto', maxHeight: '86vh', display: 'flex', flexDirection: 'column', padding: '20px 24px' }}>
    <header><div><h2>导入章节预览</h2><p>确认章节名与顺序；重名会在预览里标出，不会覆盖任何既有文件。</p></div><button disabled={locked} onClick={onCancel}>关闭</button></header>
    {error && <div role="alert" className="error">{error}</div>}
    <div className="import-preview-list" style={{ overflowY: 'auto', flex: 1, minHeight: 120 }}>
      {plan.items.map((item, index) => <div className="import-preview-row" key={item.id} data-testid={`import-row-${index}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--line, #2a2f3a)' }}>
        <input type="checkbox" aria-label={`包含 ${item.sourceName}`} disabled={locked} checked={!!included[item.id]} onChange={event => setIncluded(current => ({ ...current, [item.id]: event.target.checked }))} />
        <span className="import-preview-index" style={{ width: 28, opacity: 0.7 }}>{index + 1}</span>
        <input aria-label={`目标名 ${index + 1}`} disabled={locked} value={names[item.id]} maxLength={120} onChange={event => setNames(current => ({ ...current, [item.id]: event.target.value }))} style={{ flex: 1, minWidth: 0 }} />
        <span className="import-preview-meta" style={{ width: 130, textAlign: 'right', opacity: 0.75 }}>{item.kind.toUpperCase()} · {(item.bytes / 1024).toFixed(0)} KB</span>
        {item.duplicate && <span className="import-preview-dup" title="书名目录里已有同名文件，默认另起名字" style={{ color: '#d9a441' }}>重名</span>}
      </div>)}
      {!plan.items.length && <p role="status">没有可导入的文件。</p>}
    </div>
    {plan.skipped.length > 0 && <div className="import-preview-skipped" role="status" style={{ fontSize: 13, opacity: 0.8, paddingTop: 8 }}>
      跳过 {plan.skipped.length} 个：{plan.skipped.map(item => `${item.name}（${item.reason}）`).join('、')}
    </div>}
    {duplicateNames.length > 0 && <p role="alert" style={{ color: '#d9a441' }}>以下目标名在本次导入里重复：{duplicateNames.join('、')}</p>}
    <label style={{ display: 'block', marginTop: 10 }}>导入到分卷<select aria-label="导入目标分卷" disabled={locked} value={volume} onChange={event => setVolume(event.target.value)}><option value="">不归入分卷</option>{volumes.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
    <footer style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}><span role="status">{working ? '正在导入…' : `将导入 ${chosen.length} 章`}</span><div><button disabled={locked} onClick={onCancel}>取消</button><button className="primary" data-testid="import-confirm" disabled={locked || !chosen.length || duplicateNames.length > 0} onClick={() => void confirm()}>确认导入</button></div></footer>
  </section></div>;
}
