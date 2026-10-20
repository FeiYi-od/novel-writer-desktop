import { useEffect, useRef, useState } from 'react';
import type { KnowledgeSearchHit, KnowledgeSearchRequest, KnowledgeSearchResult, KnowledgeSourceCatalog } from '../../shared/contracts';
import { useSaveBeforeExit } from './save-before-exit';
import './knowledge.css';

const kinds = { chapter: '正文', world: '世界观', character: '人物', outline: '正式大纲', reference: '参考作品' };
const PAGE_SIZE = 50, MAX_SELECTED = 500;
const MAX_CITATIONS = 10, EMPTY_CITATIONS: KnowledgeSearchHit[] = [];
const ignoreOpenHit = () => { /* no-op default */ };
const ignoreCitationHits = (_projectId: string, _hits: KnowledgeSearchHit[]) => {};
const ignoreOpenWriter = () => {};

export function KnowledgeSearch({ projectId, title, hasUnsaved, onBusy, citationHits = EMPTY_CITATIONS, onCitationHits = ignoreCitationHits, onOpenWriter = ignoreOpenWriter, onOpenHit = ignoreOpenHit }: { projectId: string; title: string; hasUnsaved: boolean; onBusy: (busy: boolean) => void; citationHits?: KnowledgeSearchHit[]; onCitationHits?: (projectId: string, hits: KnowledgeSearchHit[]) => void; onOpenWriter?: () => void; onOpenHit?: (hit: KnowledgeSearchHit) => void }) {
  const [corpus, setCorpus] = useState<KnowledgeSearchRequest['corpus']>('discussion');
  const [mode, setMode] = useState<'keyword' | 'semantic' | 'hybrid'>('keyword');
  const [embeddingConnections, setEmbeddingConnections] = useState<{ id: string; name: string; model: string; dimensions: number }[]>([]);
  const [indexConnection, setIndexConnection] = useState('');
  const [indexStatus, setIndexStatus] = useState<{ exists: boolean; entries: number; dimensions: number; updatedAt: string; warnings: string[] } | null>(null);
  const [indexBusy, setIndexBusy] = useState(false); const [indexMessage, setIndexMessage] = useState('');
  const [rerankOn, setRerankOn] = useState(false), [rerankId, setRerankId] = useState('');
  const [rerankConnections, setRerankConnections] = useState<{ id: string; name: string; model: string }[]>([]);
  const [query, setQuery] = useState(''), [topK, setTopK] = useState(10);
  const [result, setResult] = useState<KnowledgeSearchResult | null>(null), [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState<KnowledgeSourceCatalog | null>(null), [loading, setLoading] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]), [sourceFilter, setSourceFilter] = useState('');
  const [volumeId, setVolumeId] = useState(''), [sourcePage, setSourcePage] = useState(0);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [citationIds, setCitationIds] = useState<string[]>([]), citationSelection = useRef<string[]>([]);
  const session = useRef<{ id: string; projectId: string; corpus: KnowledgeSearchRequest['corpus'] } | null>(null), mounted = useRef(true);
  const catalogSession = useRef(0), scope = useRef({ projectId, corpus });
  scope.current = { projectId, corpus };
  const loadEmbeddingConnections = async () => {
    try {
      const snapshot = await window.writer.auxiliaryModels();
      const connections = snapshot.connections.filter(connection => connection.kind === 'embedding').map(connection => ({
        id: connection.id, name: connection.name, model: connection.type,
        dimensions: Number(connection.parameters.embedding_dimensions) > 0 ? Number(connection.parameters.embedding_dimensions) : 1024
      }));
      if (!mounted.current) return;
      setEmbeddingConnections(connections);
      setRerankConnections(snapshot.connections.filter(connection => connection.kind === 'rerank').map(connection => ({ id: connection.id, name: connection.name, model: connection.type })));
      setRerankId(current => current || snapshot.connections.find(connection => connection.kind === 'rerank')?.id || '');
      setIndexConnection(current => current || connections[0]?.id || '');
    } catch { /* the keyword path stays fully usable without any embedding connection */ }
  };
  const processing = busy || loading || indexBusy;
  useSaveBeforeExit('知识检索', () => ({ dirty: false, busy: processing }));
  useEffect(() => { onBusy(processing); return () => onBusy(false); }, [processing, onBusy]);
  useEffect(() => {
    mounted.current = true;
    void loadEmbeddingConnections();
    return () => {
      mounted.current = false; catalogSession.current++;
      const active = session.current; session.current = null;
      if (active) void window.writer.cancelKnowledge(active.projectId, active.id).catch(() => {});
    };
  }, []);
  const chooseCitations = (ids: string[]) => { citationSelection.current = ids; setCitationIds(ids); };
  const clearCitations = (targetProjectId = projectId) => { chooseCitations([]); onCitationHits(targetProjectId, []); };
  const clear = (targetProjectId = projectId) => { setResult(null); setError(''); setMessage(''); clearCitations(targetProjectId); };
  const parentCitationKey = JSON.stringify(citationHits.filter(hit => hit.projectId === projectId && hit.corpus === 'canon' && hit.confirmed).map(hit => hit.id));
  useEffect(() => {
    const ids: string[] = JSON.parse(parentCitationKey);
    chooseCitations(ids.length <= MAX_CITATIONS ? ids : []);
  }, [parentCitationKey, projectId]);
  const loadCatalog = async (targetProjectId: string, targetCorpus: KnowledgeSearchRequest['corpus']) => {
    const generation = ++catalogSession.current;
    setCatalog(null); setSelectedPaths([]); setVolumeId(''); setSourceFilter(''); setSourcePage(0);
    setLoading(true); clear(targetProjectId);
    try {
      const next = await window.writer.knowledgeSources(targetProjectId, targetCorpus);
      if (!mounted.current || catalogSession.current !== generation || scope.current.projectId !== targetProjectId || scope.current.corpus !== targetCorpus) return;
      if (next.projectId !== targetProjectId || next.corpus !== targetCorpus || next.sources.length > 5000 || new Set(next.sources.map(source => source.sourcePath)).size !== next.sources.length) throw new Error('来源目录无效，请重新读取来源');
      setCatalog(next);
      setSelectedPaths(next.sources.length <= MAX_SELECTED ? next.sources.map(source => source.sourcePath) : []);
    } catch (e) {
      if (mounted.current && catalogSession.current === generation && scope.current.projectId === targetProjectId && scope.current.corpus === targetCorpus) setError(String(e));
    } finally {
      if (mounted.current && catalogSession.current === generation && scope.current.projectId === targetProjectId && scope.current.corpus === targetCorpus) setLoading(false);
    }
  };
  // Only metadata is collected here; document parsing starts after an explicit search.
  useEffect(() => {
    const active = session.current;
    if (active && (active.projectId !== projectId || active.corpus !== corpus)) {      session.current = null; setBusy(false);
      void window.writer.cancelKnowledge(active.projectId, active.id).catch(() => {});
    }
    void loadCatalog(projectId, corpus);
  }, [projectId, corpus]);
  const currentCatalog = catalog?.projectId === projectId && catalog.corpus === corpus ? catalog : null;
  const availableSources = currentCatalog?.sources ?? [];
  const volumeSources = volumeId ? availableSources.filter(source => source.volumeIds.includes(volumeId)) : availableSources;
  const visibleSources = volumeSources.filter(source => source.label.toLocaleLowerCase().includes(sourceFilter.trim().toLocaleLowerCase()));
  const pageCount = Math.max(1, Math.ceil(visibleSources.length / PAGE_SIZE)), page = Math.min(sourcePage, pageCount - 1);
  const pageSources = visibleSources.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const selectedSet = new Set(selectedPaths);
  const chooseVolume = (id: string) => {
    if (processing || !currentCatalog) return;
    const sources = id ? availableSources.filter(source => source.volumeIds.includes(id)) : availableSources;
    setVolumeId(id); setSourcePage(0); setSelectedPaths(sources.length <= MAX_SELECTED ? sources.map(source => source.sourcePath) : []); clear();
  };
  const toggleSource = (sourcePath: string, checked: boolean) => {
    if (processing || !currentCatalog) return;
    if (checked && !selectedSet.has(sourcePath) && selectedPaths.length >= MAX_SELECTED) {
      setError('每次最多选择500份来源，请先取消其他来源或缩小范围'); return;
    }
    setSelectedPaths(paths => checked ? [...paths.filter(path => path !== sourcePath), sourcePath] : paths.filter(path => path !== sourcePath));
    clear();
  };
  const search = async () => {
    if (processing || session.current || !query.trim() || !currentCatalog || !selectedPaths.length || selectedPaths.length > MAX_SELECTED) return;
    const request: KnowledgeSearchRequest = { projectId, requestId: crypto.randomUUID(), corpus, query, topK, sourcePaths: [...selectedPaths], catalogHash: currentCatalog.hash, mode, ...(rerankOn && rerankId ? { rerank: { connectionId: rerankId } } : {}) };
    const requestPaths = new Set(request.sourcePaths);
    session.current = { id: request.requestId, projectId, corpus }; setBusy(true); clear();
    try {
      const next = await window.writer.searchKnowledge(request);
      if (mounted.current && session.current?.id === request.requestId && scope.current.projectId === request.projectId && scope.current.corpus === request.corpus) {
        if (next.requestId !== request.requestId || next.projectId !== request.projectId || next.corpus !== request.corpus || !['keyword', 'semantic', 'hybrid'].includes(next.usedMode) || next.hits.some(hit => hit.projectId !== request.projectId || hit.corpus !== request.corpus || !requestPaths.has(hit.sourcePath))) throw new Error('检索结果与选定来源不一致，请重新读取来源');
        const modeNote = next.usedMode === 'keyword' ? '关键词' : next.usedMode === 'semantic' ? '语义' : '混合';
        clearCitations(request.projectId); setResult(next); setMessage(`检索完成（${modeNote}）：${next.hits.length} 条结果，${next.sourceCount} 份来源，${next.chunkCount} 个分片`);
      }
    } catch (e) {
      if (mounted.current && session.current?.id === request.requestId && scope.current.projectId === request.projectId && scope.current.corpus === request.corpus) {
        const detail = String(e); setError(detail);
        if (/来源.*变化|目录.*更新|重新读取|来源目录.*变/.test(detail)) {
          setCatalog(null); setSelectedPaths([]); setVolumeId(''); setSourcePage(0);
          setMessage('来源目录已失效，请重新读取来源后选择并检索');
        }
      }
    } finally { if (mounted.current && session.current?.id === request.requestId && scope.current.projectId === request.projectId && scope.current.corpus === request.corpus) { session.current = null; setBusy(false); } }
  };
  const stop = async () => {
    const active = session.current; if (!active) return;
    session.current = null; clear(active.projectId);
    // The result may already be in transit. The local session is invalidated even then.
    await window.writer.cancelKnowledge(active.projectId, active.id).catch(() => {});
    if (mounted.current && scope.current.projectId === active.projectId && scope.current.corpus === active.corpus && !session.current) { setBusy(false); setMessage('已停止等待检索，本次结果已丢弃'); }
  };
  const currentResult = result?.projectId === projectId && result.corpus === corpus ? result : null;
  const dimensions = embeddingConnections.find(connection => connection.id === indexConnection)?.dimensions ?? 1024;
  const loadIndexStatus = async () => {
    setIndexBusy(true); setIndexMessage(''); setError('');
    try {
      const next = await window.writer.knowledgeIndexStatus(projectId, corpus, indexConnection || undefined, indexConnection ? dimensions : undefined);
      if (mounted.current) { setIndexStatus(next); setIndexMessage(next.exists ? `索引可用：${next.entries} 个分片，${next.dimensions} 维` : (next.warnings[0] ?? '尚未建立索引')); }
    } catch (e) { if (mounted.current) setError(String(e)); } finally { if (mounted.current) setIndexBusy(false); }
  };
  const rebuildIndex = async () => {
    if (!indexConnection) { setError('请选择嵌入连接后再重建索引'); return; }
    setIndexBusy(true); setIndexMessage('正在重建索引…'); setError('');
    try {
      const result = await window.writer.rebuildKnowledgeIndex(projectId, corpus, indexConnection, dimensions);
      if (!mounted.current) return;
      const summary = `索引已更新：新嵌 ${result.stats.embedded}，复用 ${result.stats.reused}，移除 ${result.stats.removed}${result.warnings.length ? `；${result.warnings[0]}` : ''}`;
      await loadIndexStatus();
      if (mounted.current) setIndexMessage(summary);
    } catch (e) { if (mounted.current) setIndexMessage('索引重建失败或已停止'); setError(String(e)); } finally { if (mounted.current) setIndexBusy(false); }
  };
  const stopIndex = async () => { try { await window.writer.cancelKnowledgeIndex(projectId); if (mounted.current) setIndexMessage('已请求停止索引重建'); } catch (e) { if (mounted.current) setError(String(e)); } };
  const selectedCitationSet = new Set(citationIds);
  const selectedCitationHits = currentResult?.hits.filter(hit => hit.projectId === projectId && hit.corpus === 'canon' && hit.confirmed && selectedCitationSet.has(hit.id)) ?? [];
  const toggleCitation = (hit: KnowledgeSearchHit, checked: boolean) => {
    if (processing || hit.projectId !== projectId || hit.corpus !== 'canon' || !hit.confirmed || !currentResult?.hits.some(current => current.id === hit.id)) return;
    const ids = citationSelection.current;
    if (checked && !ids.includes(hit.id) && ids.length >= MAX_CITATIONS) { setError('每次最多引用10段，请先取消其他依据'); return; }
    chooseCitations(checked ? [...ids.filter(id => id !== hit.id), hit.id] : ids.filter(id => id !== hit.id)); setError('');
  };
  const useCitations = () => {
    if (processing || !selectedCitationHits.length || selectedCitationHits.length > MAX_CITATIONS) return;
    onCitationHits(projectId, selectedCitationHits.map(hit => ({ ...hit }))); onOpenWriter();
  };
  return <section className="knowledge-page ai-page" aria-label="知识检索">
    <header className="ai-heading"><div><small>{title}</small><h1>知识检索</h1><p>在本书已保存的内容中找依据，显示来源、段落和版本。</p></div></header>
    <form className="ai-panel knowledge-form" onSubmit={e => { e.preventDefault(); void search(); }}>
      <label>检索范围<select aria-label="检索范围" disabled={busy} value={corpus} onChange={e => { const next = e.target.value as KnowledgeSearchRequest['corpus']; if (next === corpus) return; setCorpus(next); setCatalog(null); setSelectedPaths([]); setIndexStatus(null); setIndexMessage(''); clear(); }}><option value="discussion">正文文稿（含另存候选）</option><option value="canon">正式内容（确认正文/设定）</option><option value="style-reference">文风参考作品</option></select></label>
      <label>关键词<input aria-label="关键词" maxLength={1000} disabled={busy} value={query} onChange={e => { setQuery(e.target.value); clear(); }} placeholder="如：图书馆 学园（空格分隔）" /></label>
      <label>最多结果<select aria-label="最多结果" disabled={busy} value={topK} onChange={e => { setTopK(Number(e.target.value)); clear(); }}>{[10, 20, 50, 100].map(value => <option key={value} value={value}>{value} 条</option>)}</select></label>
      <label>检索方式<select aria-label="检索方式" disabled={processing} value={mode} onChange={e => setMode(e.target.value as 'keyword' | 'semantic' | 'hybrid')}><option value="keyword">关键词（字面匹配）</option><option value="semantic">语义（本机向量索引）</option><option value="hybrid">混合（关键词 + 语义）</option></select></label>
      {mode !== 'keyword' && <p className="knowledge-warning">语义与混合需要已配置嵌入连接并建立本书索引；任一条件不满足会自动降级为关键词，结果里会说明原因。</p>}
      <label className="ai-check"><input type="checkbox" aria-label="使用重排" checked={rerankOn} disabled={processing} onChange={e => setRerankOn(e.target.checked)} />使用重排（本机配置，失败时保持原排序）</label>
      {rerankOn && <label>重排连接<select aria-label="重排连接" disabled={processing} value={rerankId} onChange={e => setRerankId(e.target.value)}><option value="">选择重排连接</option>{rerankConnections.map(connection => <option key={connection.id} value={connection.id}>{connection.name} · {connection.model}</option>)}</select></label>}
      <details className="knowledge-index"><summary>语义索引（本机 Ollama 嵌入）</summary>
        <label>嵌入连接<select aria-label="嵌入连接" disabled={processing} value={indexConnection} onChange={e => { setIndexConnection(e.target.value); setIndexStatus(null); setIndexMessage(''); }}><option value="">未选择嵌入连接</option>{embeddingConnections.map(connection => <option key={connection.id} value={connection.id}>{connection.name} · {connection.model}</option>)}</select></label>
        <p className="usage-scope">维度 {dimensions}（来自嵌入选型配置）；索引按本书与用途分开保存，重建只补新增或变化的来源。</p>
        <div className="actions"><button type="button" disabled={processing} onClick={() => void loadEmbeddingConnections()}>刷新嵌入连接</button><button type="button" disabled={processing} onClick={() => void loadIndexStatus()}>读取索引状态</button><button type="button" disabled={processing || !indexConnection} onClick={() => void rebuildIndex()}>重建索引</button><button type="button" disabled={!indexBusy} onClick={() => void stopIndex()}>停止重建</button></div>
        {indexStatus && <p>{indexStatus.exists ? `已建索引：${indexStatus.entries} 个分片 · ${indexStatus.dimensions} 维 · ${new Date(indexStatus.updatedAt).toLocaleString()}` : '尚未建立索引'}</p>}
        {indexMessage && <p role="status">{indexMessage}</p>}
        {indexStatus?.warnings.map(warning => <p className="usage-warning" key={warning}>{warning}</p>)}
      </details>
      <p>按字面匹配任意关键词，不区分大小写；最多16个关键词，每个不超过100字。仅本机读取，不调用模型。</p>
      {corpus === 'discussion' ? <p>只搜索本书文件夹中的已保存 DOCX/TXT，包含作者文稿和另存候选；此范围作为文稿快照，文件保存不会自动确认正史。</p> : corpus === 'canon' ? <p>作者明确确认且原件版本匹配的正文、已保存人物/世界观、启用角色卡和正式大纲参与检索。普通保存、未确认候选、过期确认、筹备草稿、停用卡片、参考作品不进入此范围；确认记录在正文改变后失效。</p> : <p>只搜索本书研习室登记的参考作品，用于寻找表达样本；参考情节不作为本书正史。</p>}
      {hasUnsaved && <p className="knowledge-warning">当前有未保存内容，检索读取磁盘上已保存的版本。保存后重新检索才能看到新内容。</p>}
      <fieldset className="knowledge-sources" disabled={busy}>
        <legend>选择检索来源</legend>
        <div className="knowledge-source-tools">
          {corpus === 'discussion' && <label>检索分卷<select aria-label="检索分卷" disabled={loading || !currentCatalog} value={volumeId} onChange={e => chooseVolume(e.target.value)}><option value="">全部分卷</option>{currentCatalog?.volumes.map(volume => <option key={volume.id} value={volume.id}>{volume.title}</option>)}</select></label>}
          <label>筛选来源名称<input aria-label="筛选来源名称" disabled={loading || !currentCatalog} value={sourceFilter} maxLength={500} onChange={e => { setSourceFilter(e.target.value); setSourcePage(0); clear(); }} placeholder="输入章节或资料名称" /></label>
          <button type="button" disabled={processing} onClick={() => void loadCatalog(projectId, corpus)}>重新读取来源</button>
        </div>
        <p className="knowledge-source-note">只读取来源目录；点击检索后才解析勾选内容。名称筛选只改变列表，检索仍使用全部勾选来源。分卷归属不会改变文稿的确认状态。</p>
        {loading ? <p role="status">正在读取来源目录…</p> : currentCatalog ? <>
          <p role="status">已选择 {selectedPaths.length} / 总共 {availableSources.length} 份来源 · 当前范围 {visibleSources.length} 份</p>
          {availableSources.length > MAX_SELECTED && <p className="knowledge-warning">来源超过500份，请按分卷或名称缩小范围后勾选，最多选择500份。</p>}
          <div className="knowledge-source-actions">
            <button type="button" disabled={!visibleSources.length || visibleSources.length > MAX_SELECTED} onClick={() => { setSelectedPaths(visibleSources.map(source => source.sourcePath)); clear(); }}>全选当前范围</button>
            <button type="button" disabled={!selectedPaths.length} onClick={() => { setSelectedPaths([]); clear(); }}>清空选择</button>
          </div>
          {!availableSources.length ? <p>此范围没有可检索来源。</p> : !visibleSources.length ? <p>当前分卷或名称下没有来源，可以清空筛选或切换分卷。</p> : <>
            <ul className="knowledge-source-list">{pageSources.map(source => <li key={source.sourcePath}>
              <label><input type="checkbox" aria-label={source.label} checked={selectedSet.has(source.sourcePath)} onChange={e => toggleSource(source.sourcePath, e.target.checked)} /><span><strong>{source.label}</strong><small>{kinds[source.kind]}</small></span></label>
            </li>)}</ul>
            <div className="knowledge-source-pages">
              <button type="button" disabled={page === 0} onClick={() => setSourcePage(page - 1)}>上一页来源</button>
              <span>来源第 {page + 1} / {pageCount} 页，每页最多50份</span>
              <button type="button" disabled={page + 1 >= pageCount} onClick={() => setSourcePage(page + 1)}>下一页来源</button>
            </div>
          </>}
          {!!currentCatalog.warnings.length && <div className="knowledge-warnings"><strong>来源目录说明</strong><ul>{currentCatalog.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></div>}
        </> : <p>请重新读取来源，再勾选需要检索的内容。</p>}
      </fieldset>
      <div className="actions"><button type="submit" className="primary" disabled={processing || !query.trim() || !currentCatalog || !selectedPaths.length}>检索本书</button>{busy && <button type="button" onClick={() => void stop()}>停止检索</button>}</div>
    </form>
    {error && <div role="alert" className="error">{error}</div>}{message && <p role="status">{message}</p>}
    {currentResult && <>
      <p className="knowledge-note">这是本次读取的快照。来源修改后请重新检索；长段相邻摘录可能有重叠。只有正式内容中已确认的结果可勾选为本书写作与审稿依据，最多10段；选择依据不会调用模型。</p>
      {corpus === 'canon' && <div className="knowledge-citation-actions" aria-label="检索依据选择"><p role="status">已勾选 {selectedCitationHits.length} / {MAX_CITATIONS} 段依据</p><button className="primary" disabled={processing || !selectedCitationHits.length} onClick={useCitations}>用于本书写作与审稿</button></div>}
      {!!currentResult.warnings.length && <div className="knowledge-warnings" role="status"><strong>本次读取说明</strong><ul>{currentResult.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></div>}
      {!currentResult.hits.length && <p>没有找到匹配内容，可以减少关键词或切换检索范围。未命中不能证明某项设定不存在。</p>}
      <ol className="knowledge-results">{currentResult.hits.map(hit => <li className="knowledge-hit" key={hit.id}>
        <header><h2>{hit.sourceLabel}</h2><span>{kinds[hit.sourceKind]}</span></header>
        <p>源文本段落 {hit.startParagraph + 1}{hit.endParagraph !== hit.startParagraph && `–${hit.endParagraph + 1}`} · 版本 {hit.sourceHash.slice(0, 12)}</p>
        {corpus === 'discussion' && !hit.confirmed && <p>文稿快照 · 未确认为正史</p>}
        {hit.corpus === 'style-reference' && <p>表达参考 · 不作为本书故事事实</p>}
        {hit.corpus === 'canon' && hit.confirmed && <label className="knowledge-citation-check"><input type="checkbox" aria-label={`引用依据 ${hit.id}`} checked={selectedCitationSet.has(hit.id)} disabled={processing} onChange={e => toggleCitation(hit, e.target.checked)} />选为本书写作与审稿依据</label>}
        {hit.sourceKind === 'chapter' && (hit.corpus === 'discussion' || hit.corpus === 'canon') && <button type="button" disabled={processing} onClick={() => onOpenHit(hit)}>在编辑器中打开</button>}
        <pre>{hit.text}</pre>
      </li>)}</ol>
    </>}
  </section>;
}
