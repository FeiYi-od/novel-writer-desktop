import { useEffect, useRef, useState, type RefObject } from 'react';
import type { AuxiliaryModelEdit, AuxiliaryModelSnapshot } from '../../shared/contracts';
import { astrbotTemplates } from '../../shared/model-presets';
import { useSaveBeforeExit } from './save-before-exit';

const allowed = /api_base$|model$|dimensions|dimensions_mode|^timeout$|^input_type$|api_suffix$|model_endpoint$|^return_documents$|^instruct$|^.*truncate$|^tei_rerank_(truncation_direction|raw_scores|return_text)$/;
const labels: Record<string, string> = { timeout: '请求超时（秒）', embedding_dimensions: '嵌入维度', embedding_dimensions_mode: '维度模式', input_type: '输入类型', rerank_api_suffix: '接口后缀', return_documents: '返回原文', instruct: '重排序指令', nvidia_rerank_model_endpoint: '模型接口后缀', nvidia_rerank_truncate: '截断方式（留空按服务默认）' };
const label = (key: string) => labels[key] ?? (key.endsWith('api_base') ? 'API 基础地址' : key.endsWith('_model') ? '模型名称' : key);
const editable = ({ hasKey: _hasKey, ...value }: AuxiliaryModelSnapshot['connections'][number]): AuxiliaryModelEdit => ({ ...value, apiKey: '' });
export function KnowledgeSettings({ kind, onDirty, hashRef }: { kind: 'embedding' | 'rerank'; onDirty: (value: boolean) => void; hashRef: RefObject<string | null> }) {
  const templates = astrbotTemplates.filter(t => t.provider_type === kind), title = kind === 'embedding' ? '嵌入模型' : '重排序模型';
  const initial = (): AuxiliaryModelEdit => ({ kind, name: '', type: templates[0].type, parameters: {}, apiKey: '' });
  const [snapshot, setSnapshot] = useState<AuxiliaryModelSnapshot>({ connections: [], hash: '' }), [edit, setEdit] = useState(initial);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const testSession = useRef<string | null>(null); const [testing, setTesting] = useState(false);
  const cancelTest = (id: string) => kind === 'embedding' ? window.writer.cancelEmbeddingTest(id) : window.writer.cancelRerankTest(id);
  useEffect(() => { let disposed = false; void window.writer.auxiliaryModels().then(next => { if (!disposed) { setSnapshot(next); if (hashRef.current === null) hashRef.current = next.hash; } }).catch(e => { if (!disposed) setError(String(e)); }); return () => { disposed = true; }; }, []);
  useEffect(() => { onDirty(dirty || busy); return () => onDirty(false); }, [dirty, busy, onDirty]);
  const save = async () => { const next = await window.writer.saveAuxiliaryModel(edit, hashRef.current ?? snapshot.hash); const saved = next.connections.find(c => c.id === edit.id) ?? next.connections.at(-1)!; hashRef.current = next.hash; setSnapshot(next); setEdit(editable(saved)); setDirty(false); setMessage(`${title}配置已保存`); };
  useSaveBeforeExit(title, () => ({ dirty, busy, save }));
  const switchEdit = (next: AuxiliaryModelEdit) => { if (dirty && !window.confirm(`放弃未保存的${title}配置？`)) return; setEdit(next); setDirty(false); setError(''); setMessage(''); };
  const test = async () => {
    if (!edit.id || busy || dirty || testSession.current) return;
    const id = crypto.randomUUID(), connectionId = edit.id; testSession.current = id; setTesting(true); setBusy(true); setError(''); setMessage('');
    try {
      if (kind === 'embedding') {
        const result = await window.writer.testEmbeddingModel(connectionId, hashRef.current ?? snapshot.hash, id);
        if (testSession.current === id && result.connectionId === connectionId && result.requestId === id) setMessage('嵌入测试通过：' + result.inputCount + '条虚构文本，实际' + result.dimensions + '维' + (result.dimensionMatches ? '，维度匹配' : '；配置维度不匹配，请核对后修改，未自动改配置'));
      } else {
        const result = await window.writer.testRerankModel(connectionId, hashRef.current ?? snapshot.hash, id);
        if (testSession.current === id && result.connectionId === connectionId && result.requestId === id) setMessage(`重排序测试完成：${result.candidateCount} 条虚构候选，返回 ${result.results.length} 条；顺序 ${result.results.map(item => item.index + 1).join(' → ')}；得分 ${result.results.map(item => item.score).join(' / ')}`);
      }
    }
    catch (e) { if (testSession.current === id) setError(String(e)); }
    finally { if (testSession.current === id) { testSession.current = null; setTesting(false); setBusy(false); } }
  };
  useEffect(() => () => { const id = testSession.current; testSession.current = null; if (id) void cancelTest(id).catch(() => {}); }, []);
  const change = (patch: Partial<AuxiliaryModelEdit>) => { setEdit(current => ({ ...current, ...patch })); setDirty(true); setMessage(''); };
  return <section className="ai-panel ai-form" aria-label={`${title}配置`}>
    <h2>{title}配置</h2><p>选项和字段沿用AstrBot，独立于对话模型和小说资料。可显式测试接口；实际知识库索引与检索尚未接通。</p>
    {error && <div role="alert" className="error">{error}</div>}{message && <p role="status">{message}</p>}
    <div className="actions">{snapshot.connections.filter(c => c.kind === kind).map(c => <button disabled={busy} key={c.id} onClick={() => switchEdit(editable(c))}>{c.name}</button>)}<button disabled={busy} onClick={() => switchEdit(initial())}>＋ 新增{title}配置</button></div>
    <label>{title}提供商<select aria-label={`${title}提供商`} disabled={busy || !!edit.id} value={Object.keys(edit.parameters).length ? edit.type : ''} onChange={e => { const t = templates.find(t => t.type === e.target.value); if (t) change({ type: t.type, name: t.label, parameters: Object.fromEntries(Object.entries(t).filter(([k, v]) => allowed.test(k) && ['string', 'number', 'boolean'].includes(typeof v))) as AuxiliaryModelEdit['parameters'], apiKey: '' }); }}><option value="" disabled>选择提供商</option>{templates.map(t => <option key={t.type} value={t.type}>{t.label}</option>)}</select></label>
    <label>连接名称<input aria-label={`${title}连接名称`} disabled={busy} maxLength={100} value={edit.name} onChange={e => change({ name: e.target.value })} /></label>
    {Object.entries(edit.parameters).map(([key, value]) => <label key={key}>{label(key)}{typeof value === 'boolean' ? <input type="checkbox" aria-label={`${title} ${label(key)}`} disabled={busy} checked={value} onChange={e => change({ parameters: { ...edit.parameters, [key]: e.target.checked } })} /> : <input aria-label={`${title} ${label(key)}`} type={typeof value === 'number' ? 'number' : 'text'} disabled={busy} value={value} onChange={e => change({ parameters: { ...edit.parameters, [key]: typeof value === 'number' ? Number(e.target.value) : e.target.value } })} />}</label>)}
    <label>API 密钥<input aria-label={`${title} API 密钥`} type="password" autoComplete="off" disabled={busy} value={edit.apiKey ?? ''} placeholder={edit.id ? '留空保留已存密钥' : '本机免密服务可留空'} onChange={e => change({ apiKey: e.target.value })} /></label>
    {edit.id && <label><input type="checkbox" disabled={busy} checked={!!edit.clearKey} onChange={e => change({ clearKey: e.target.checked })} />清除此配置密钥</label>}
    <button className="primary" disabled={busy || !dirty || !edit.name.trim() || !Object.keys(edit.parameters).length} onClick={async () => { setBusy(true); setError(''); try { await save(); } catch (e) { setError(String(e)); } finally { setBusy(false); } }}>保存{title}配置</button>
    <div className="actions"><button disabled={busy || dirty || !edit.id} onClick={() => void test()}>测试{title}（虚构文本）</button>{testing && <button onClick={() => { const id = testSession.current; if (id) void cancelTest(id).catch(e => setError(String(e))); }}>停止{kind === 'embedding' ? '嵌入' : '重排序'}测试</button>}</div>
    {kind === 'embedding' && <p>测试仅发送两条固定虚构句子，远程调用可能计费；不会发送小说。结果只展示，不自动修改维度或建立索引。</p>}
    {kind === 'rerank' && <p>测试仅发送固定虚构问题和三条候选，远程调用可能计费；不会发送小说。显示候选序号与得分，不写入索引或修改配置。</p>}
    {kind === 'rerank' && edit.type === 'nvidia_rerank' && <p>截断方式留空沿用服务默认，长文本可能被截断；填写 NONE 可在超限时报错，END 允许尾部截断。请按部署能力选择。</p>}
    <small>维度与模型名称是上游模板默认值，须按实际部署调整；不会下载或启动本地模型。配置仅存本机加密文件。</small>
  </section>;
}
