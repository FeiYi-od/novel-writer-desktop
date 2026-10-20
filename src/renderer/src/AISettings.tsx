import { useEffect, useRef, useState } from 'react';
import type { AIConnection, AIConnectionEdit, AIConnectionSnapshot, AIModelList } from '../../shared/contracts';
import { chatPresets } from '../../shared/model-presets';
import { KnowledgeSettings } from './KnowledgeSettings';
import { DetectorSettings } from './DetectorSettings';
import { useSaveBeforeExit } from './save-before-exit';
import { capabilitySummary, describeModel, filterModels, type ModelCapability } from '../../core/model-capabilities';

const initial = (): AIConnectionEdit => ({ name: '', baseUrl: '', model: '', adapter: 'generic', thinking: 'default', timeoutSeconds: 300, contextWindow: 32768, maxOutputTokens: 4096, tokenParameter: 'max_tokens', apiKey: '' });
const presets = chatPresets;

export function AISettings({ onDirty, onSaved }: { onDirty: (value: boolean) => void; onSaved: (connections: AIConnection[]) => void }) {
  const [category, setCategory] = useState<'chat' | 'embedding' | 'rerank' | 'detector'>('chat');
  const [capability, setCapability] = useState<ModelCapability[]>([]);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 20;
  const auxiliaryHash = useRef<string | null>(null);
  const [detectorDirty, setDetectorDirty] = useState(false);
  const [embeddingDirty, setEmbeddingDirty] = useState(false), [rerankDirty, setRerankDirty] = useState(false);
  const [modelList, setModelList] = useState<AIModelList | null>(null); const formVersion = useRef(0);
  const [snapshot, setSnapshot] = useState<AIConnectionSnapshot>({ connections: [], hash: '' });
  const [edit, setEdit] = useState(initial); const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(''); const [error, setError] = useState('');
  const accept = (next: AIConnectionSnapshot) => { setSnapshot(next); onSaved(next.connections); };
  useEffect(() => { void window.writer.aiConnections().then(accept).catch(e => setError(String(e))); }, []);
  useEffect(() => { onDirty(dirty || busy || embeddingDirty || rerankDirty || detectorDirty); return () => onDirty(false); }, [dirty, busy, embeddingDirty, rerankDirty, detectorDirty, onDirty]);
  const change = (patch: Partial<AIConnectionEdit>) => { formVersion.current++; if ('baseUrl' in patch || 'adapter' in patch || 'apiKey' in patch || 'clearKey' in patch) setModelList(null); setEdit(current => ({ ...current, ...patch })); setDirty(true); setMessage(''); };
  const switchEdit = (next: AIConnectionEdit) => { if (dirty && !window.confirm('放弃未保存的模型配置？')) return; formVersion.current++; setModelList(null); setEdit(next); setDirty(false); setMessage(''); setError(''); };
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action(); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  const save = async () => { const next = await window.writer.saveAIConnection(edit, snapshot.hash); accept(next); const saved = next.connections.find(p => p.id === edit.id) ?? next.connections.at(-1)!; formVersion.current++; setModelList(null); setEdit({ ...saved, apiKey: '' }); setDirty(false); setMessage('模型连接已保存'); };
  useSaveBeforeExit('对话模型配置', () => ({ dirty, busy, save }));
  async function loadModels(force: boolean) {
    await run(async () => {
      const version = formVersion.current;
      setModelList(null);
      const result = await window.writer.discoverAIModels({ connectionId: edit.id, expectedHash: snapshot.hash, baseUrl: edit.baseUrl, apiKey: edit.apiKey, clearKey: edit.clearKey, adapter: edit.adapter, refresh: force });
      if (version !== formVersion.current) return;
      setPage(0);
      setModelList(result);
      setMessage(result.models.length ? (result.cached ? '已读取缓存的模型列表' : '模型列表已获取，请选择或手工填写') : '服务未列出模型，可以继续手工填写');
    });
  }
  return <section className="ai-page">
    <header className="ai-heading"><div><small>MODEL CONNECTIONS</small><h1>模型设置</h1><p>保存多个模型连接，在写作与审稿时分别选择。</p></div></header>
    <div className="actions model-categories"><button className={category === 'chat' ? 'primary' : ''} onClick={() => setCategory('chat')}>对话模型</button><button className={category === 'embedding' ? 'primary' : ''} onClick={() => setCategory('embedding')}>嵌入模型</button><button className={category === 'rerank' ? 'primary' : ''} onClick={() => setCategory('rerank')}>重排序模型</button><button className={category === 'detector' ? 'primary' : ''} onClick={() => setCategory('detector')}>朱雀检测连接</button></div>
    <div hidden={category !== 'embedding'}><KnowledgeSettings kind="embedding" onDirty={setEmbeddingDirty} hashRef={auxiliaryHash} /></div><div hidden={category !== 'rerank'}><KnowledgeSettings kind="rerank" onDirty={setRerankDirty} hashRef={auxiliaryHash} /></div>
    <div hidden={category !== 'detector'}>{error && <div className="error" role="alert">{error}</div>}<DetectorSettings onDirty={setDetectorDirty} /></div>
    <div hidden={category !== 'chat'}>
    {error && <div className="error" role="alert">{error}</div>}{message && <p role="status">{message}</p>}
    <div className="ai-columns"><aside className="ai-panel"><h2>我的模型</h2>
      {snapshot.connections.map(profile => <button disabled={busy} className={edit.id === profile.id ? 'active' : ''} key={profile.id} onClick={() => switchEdit({ ...profile, apiKey: '' })}>{profile.name}<small>{profile.model} · {profile.hasKey ? '密钥已保存' : '无密钥'}</small></button>)}
      <button disabled={busy} onClick={() => switchEdit(initial())}>＋ 新增模型连接</button>
      <p>密钥使用本机系统加密，保存后不会回传显示。模型配置不放入小说目录。</p>
    </aside><form className="ai-panel ai-form" onSubmit={event => { event.preventDefault(); void run(async () => {
      await save();
    }); }}>
      <h2>{edit.id ? '编辑模型连接' : '新增模型连接'}</h2>
      {!edit.id && <label>快捷配置<select aria-label="快捷配置" defaultValue="" disabled={busy} onChange={e => { const preset = presets[Number(e.target.value)]; if (preset?.available) change({ ...initial(), ...preset.value }); }}><option value="" disabled>选择平台</option>{presets.map((p, i) => <option key={p.label} value={i} disabled={!p.available}>{p.label}{!p.available && '（待适配）'}</option>)}</select></label>}
      <label>连接名称<input aria-label="连接名称" required disabled={busy} value={edit.name} onChange={e => change({ name: e.target.value })} /></label>
      <label>API 基础地址<input aria-label="API 基础地址" required disabled={busy} value={edit.baseUrl} placeholder="https://api.deepseek.com" onChange={e => change({ baseUrl: e.target.value })} /></label>
      <label>模型名称<input aria-label="模型名称" required disabled={busy} value={edit.model} placeholder="填写服务商提供的模型 ID" onChange={e => change({ model: e.target.value })} /></label>
      <div className="actions"><button type="button" disabled={busy || !edit.baseUrl.trim()} onClick={() => void loadModels(false)}>获取模型列表</button>
        <button type="button" data-testid="models-refresh" disabled={busy || !edit.baseUrl.trim()} onClick={() => void loadModels(true)}>刷新（忽略缓存）</button></div>
      {modelList?.cached && <p className="notice" role="status" data-testid="models-cached">这份列表来自缓存（{new Date(modelList.checkedAt).toLocaleString()}），点「刷新（忽略缓存）」向服务重新获取。</p>}
      {modelList && (() => {
        const profiles = modelList.models.map(model => ({ ...describeModel({ id: model.id, context_length: model.contextWindow ?? undefined }), name: model.name }));
        const visibleAll = filterModels(profiles, capability);
        const pages = Math.max(1, Math.ceil(visibleAll.length / PAGE_SIZE));
        const current = Math.min(page, pages - 1);
        const visible = visibleAll.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
        return <><div className="actions capability-filter">{([['reasoning', '推理'], ['vision', '视觉'], ['long-context', '长上下文'], ['tools', '工具']] as [ModelCapability, string][]).map(([id, label]) => <label key={id} className="ai-check"><input type="checkbox" aria-label={`能力筛选 ${label}`} disabled={busy} checked={capability.includes(id)} onChange={e => { setPage(0); setCapability(list => e.target.checked ? [...list, id] : list.filter(item => item !== id)); }} />{label}</label>)}
          <span className="notice" role="status">{visibleAll.length}/{profiles.length} 个模型符合{pages > 1 ? ` · 第 ${current + 1}/${pages} 页` : ''}</span>
          {pages > 1 && <><button type="button" data-testid="models-prev" disabled={busy || current === 0} onClick={() => setPage(current - 1)}>上一页</button><button type="button" data-testid="models-next" disabled={busy || current >= pages - 1} onClick={() => setPage(current + 1)}>下一页</button></>}
        </div>
          <label>服务商模型列表<select aria-label="服务商模型列表" value="" disabled={busy} onChange={e => { if (e.target.value) change({ model: e.target.value }); }}><option value="">选择一个模型 ID</option>{visible.map(profile => <option key={profile.id} value={profile.id}>{profile.id} — {capabilitySummary(profile)}</option>)}</select></label>
          <small>列表由当前服务返回；标签按模型名与上报的上下文长度推断，选能力只影响筛选，不改窗口预算。</small></>;
      })()}
      <label>API 密钥<input aria-label="API 密钥" type="password" autoComplete="off" disabled={busy} value={edit.apiKey ?? ''} placeholder={edit.id ? '留空保留已保存密钥' : '本机免密服务可以留空'} onChange={e => change({ apiKey: e.target.value })} /></label>
      {edit.id && <label className="ai-check"><input type="checkbox" checked={!!edit.clearKey} disabled={busy} onChange={e => change({ clearKey: e.target.checked })} />清除已保存密钥</label>}
      <div className="ai-fields"><label>参数适配<select aria-label="参数适配" disabled={busy} value={edit.adapter} onChange={e => change({ adapter: e.target.value as AIConnection['adapter'], thinking: 'default' })}><option value="generic">OpenAI / 本地兼容</option><option value="deepseek">DeepSeek 官方</option><option value="qwen">百炼 / 通义千问</option><option value="gemini">Google Gemini 原生</option><option value="anthropic">Anthropic Claude 原生</option></select></label>
      <label>深度思考<select aria-label="深度思考" disabled={busy || !['deepseek', 'qwen'].includes(edit.adapter)} value={edit.thinking} onChange={e => change({ thinking: e.target.value as AIConnection['thinking'] })}><option value="default">按服务商默认</option><option value="disabled">关闭</option><option value="enabled">开启</option></select></label>
      <label>上下文窗口<input aria-label="上下文窗口" type="number" min="512" max="2000000" required disabled={busy} value={edit.contextWindow} onChange={e => change({ contextWindow: Number(e.target.value) })} /></label>
      <label>最大输出 token<input aria-label="最大输出 token" type="number" min="1" max="128000" required disabled={busy} value={edit.maxOutputTokens} onChange={e => change({ maxOutputTokens: Number(e.target.value) })} /></label>
      <label>输出参数<select aria-label="输出参数" disabled={busy} value={edit.tokenParameter} onChange={e => change({ tokenParameter: e.target.value as AIConnection['tokenParameter'] })}><option value="max_tokens">max_tokens（国内兼容接口常用）</option><option value="max_completion_tokens">max_completion_tokens</option></select></label>
      <label>请求超时（秒）<input aria-label="请求超时（秒）" type="number" min="30" max="1800" required disabled={busy} value={edit.timeoutSeconds} onChange={e => change({ timeoutSeconds: Number(e.target.value) })} /></label></div>
      <p>窗口数值是请求预算配置，请按实际模型能力填写。仅最终回答进入候选稿，推理流不会混入正文。百炼其他地域请替换对应地址与密钥。</p>
      <div className="actions"><button className="primary" disabled={busy} type="submit">保存模型连接</button><button type="button" disabled={busy || dirty || !edit.id} onClick={() => void run(async () => setMessage(await window.writer.testAIConnection(edit.id!)))}>测试连接（少量 token）</button></div>
      <small>测试发送简短请求，可能计费；DeepSeek / 千问测试会关闭思考。Gemini/Claude使用原生协议与模型默认思考，推理片段不写入正文。Ollama/LM Studio使用本机OpenAI兼容接口，可不填密钥。特殊协议、工具和图像功能待适配。</small>
    </form></div></div>
  </section>;
}
