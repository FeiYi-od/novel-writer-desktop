import { useState } from 'react';
import type { AIConnectionEdit } from '../../shared/contracts';
import { chatPresets } from '../../shared/model-presets';

const presets = chatPresets.filter(preset => preset.available && preset.value.baseUrl);
const defaultModel = (label: string) => /deepseek/iu.test(label) ? 'deepseek-chat'
  : /千问|qwen|百炼/iu.test(label) ? 'qwen-plus'
  : /openrouter/iu.test(label) ? 'openai/gpt-4o-mini'
  : /gemini|google/iu.test(label) ? 'gemini-2.5-pro'
  : /claude|anthropic/iu.test(label) ? 'claude-sonnet-4-5'
  : '';

/** One place to paste an API key: pick a provider, paste the key, save, and immediately verify it by
 * asking the provider for its model list (no tokens spent). */
export function QuickConnectPanel({ blocked, onDone, onClose }: { blocked: boolean; onDone: () => void; onClose: () => void }) {
  const [preset, setPreset] = useState(presets[0]?.label ?? '');
  const initial = presets[0]?.value ?? {};
  const [name, setName] = useState(String(initial.name ?? ''));
  const [baseUrl, setBaseUrl] = useState(String(initial.baseUrl ?? ''));
  const [adapter, setAdapter] = useState<AIConnectionEdit['adapter']>((initial.adapter as AIConnectionEdit['adapter']) ?? 'generic');
  const [key, setKey] = useState('');
  const [model, setModel] = useState(defaultModel(presets[0]?.label ?? ''));
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [result, setResult] = useState('');
  const pick = (label: string) => {
    const found = presets.find(item => item.label === label);
    setPreset(label);
    if (!found) return;
    setName(String(found.value.name ?? label));
    setBaseUrl(String(found.value.baseUrl ?? ''));
    setAdapter((found.value.adapter as AIConnectionEdit['adapter']) ?? 'generic');
    setModel(defaultModel(label));
    setResult(''); setError('');
  };
  const run = async (testAfterSave: boolean) => {
    setBusy(true); setError(''); setResult('');
    try {
      if (!baseUrl.trim() || !name.trim() || !model.trim()) throw new Error('请填写连接名称、接口地址与模型 ID');
      const snapshot = await window.writer.aiConnections();
      const existing = snapshot.connections.find(item => item.name === name.trim());
      const edit: AIConnectionEdit = {
        id: existing?.id, name: name.trim(), baseUrl: baseUrl.trim(), model: model.trim(), adapter,
        thinking: 'default', timeoutSeconds: 300, contextWindow: existing?.contextWindow ?? 32768,
        maxOutputTokens: existing?.maxOutputTokens ?? 4096, tokenParameter: existing?.tokenParameter ?? 'max_tokens',
        apiKey: key.trim() || undefined, clearKey: false
      };
      const saved = await window.writer.saveAIConnection(edit, snapshot.hash);
      const connection = saved.connections.find(item => item.name === name.trim());
      setKey('');
      onDone();
      if (!testAfterSave) { setResult('已保存连接。可以随时用「测试连接」验证。'); return; }
      if (!connection) throw new Error('保存后没有找到该连接');
      const models = await window.writer.discoverAIModels({ connectionId: connection.id, expectedHash: saved.hash, baseUrl: baseUrl.trim(), adapter });
      setResult(`连接成功：服务返回 ${models.models.length} 个模型${models.models.length ? `（例如 ${models.models.slice(0, 3).map(item => item.id).join('、')}）` : ''}。`);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
    } finally { setBusy(false); }
  };
  return <div className="modal-overlay"><section className="book-modal quick-connect" role="dialog" aria-modal="true" aria-label="接入 API">
    <header><div><h2>接入 API</h2><p>选服务商 → 粘贴密钥 → 保存并测试。密钥只保存在本机系统凭据里（加密），不会写进小说或日志。</p></div></header>
    {error && <div role="alert" className="error">{error}</div>}{result && <p className="notice" role="status" data-testid="quick-result">{result}</p>}
    <label>服务商<select aria-label="快速接入服务商" disabled={busy || blocked} value={preset} onChange={e => pick(e.target.value)}>{presets.map(item => <option key={item.label} value={item.label} title={item.note}>{item.label}</option>)}</select></label>
    <label>连接名称<input aria-label="快速接入名称" disabled={busy || blocked} value={name} onChange={e => setName(e.target.value)} /></label>
    <label>接口地址<input aria-label="快速接入地址" disabled={busy || blocked} value={baseUrl} onChange={e => setBaseUrl(e.target.value)} /></label>
    <label>模型 ID<input aria-label="快速接入模型" disabled={busy || blocked} value={model} onChange={e => setModel(e.target.value)} placeholder="例如 deepseek-chat" /></label>
    <label>API 密钥<input aria-label="快速接入密钥" type="password" autoComplete="off" disabled={busy || blocked} value={key} onChange={e => setKey(e.target.value)} placeholder="粘贴你从服务商拿到的 key" /></label>
    <div className="actions">
      <button data-testid="quick-save" disabled={busy || blocked || !key.trim()} onClick={() => void run(false)}>只保存</button>
      <button data-testid="quick-save-test" className="primary" disabled={busy || blocked || !key.trim()} onClick={() => void run(true)}>{busy ? '正在测试…' : '保存并测试'}</button>
    </div>
    <small>{presets.find(item => item.label === preset)?.note ?? ''}。测试只请求服务商的模型列表（不消耗生成额度）；失败时会显示具体原因，例如密钥无效或地址不对。</small>
    <footer><button onClick={onClose}>关闭</button></footer>
  </section></div>;
}
