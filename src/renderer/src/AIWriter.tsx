import { useEffect, useRef, useState } from 'react';
import type { AIConnection, AIRequest, AITask, KnowledgeCitationReference, KnowledgeSearchHit, Manuscript } from '../../shared/contracts';
import { ReviewChanges } from './ReviewChanges';
import { parseReview } from '../../core/review';
import { mergeReportIssues } from '../../core/report-merge';
import { ProviderBadge } from './ProviderBadge';
import './knowledge.css';
import './ai-writing-polish.css';
const labels: Record<AITask['status'], string> = { running: '生成中', complete: '已完成', incomplete: '未完整结束', cancelled: '已取消', failed: '失败', interrupted: '上次运行中断' };
const reviewLabels = { pending: '等待依次审稿', running: '审稿中', complete: '已完成', failed: '失败', skipped: '未执行', interrupted: '上次中断' };
const autoReviews = (task: AITask) => task.autoReviews ?? (task.autoReview ? [task.autoReview] : []);
const workflowPending = (task: AITask) => autoReviews(task).some(review => review.status === 'pending' || review.status === 'running');
const EMPTY_CITATIONS: KnowledgeSearchHit[] = [];
const ignoreCitations = () => {};
const citationReference = (citation: KnowledgeCitationReference | KnowledgeSearchHit): KnowledgeCitationReference => ({ id: citation.id, projectId: citation.projectId, corpus: citation.corpus as 'canon', sourcePath: citation.sourcePath, sourceHash: citation.sourceHash, startParagraph: citation.startParagraph, endParagraph: citation.endParagraph });
const paragraphRange = (citation: KnowledgeCitationReference) => `${citation.startParagraph + 1}${citation.endParagraph === citation.startParagraph ? '' : `–${citation.endParagraph + 1}`}`;

export function AIWriter({ projectId, title, manuscript, blocked, connections, onSettings, onExport, citationHits = EMPTY_CITATIONS, onClearCitations = ignoreCitations, onKnowledge = ignoreCitations, fill }: { projectId: string; title: string; manuscript: Manuscript | null; blocked: boolean; connections: AIConnection[]; onSettings: () => void; onExport: (id: string) => Promise<void>; citationHits?: KnowledgeSearchHit[]; onClearCitations?: () => void; onKnowledge?: () => void; fill?: { text: string; token: number } | null }) {
  const [writer, setWriter] = useState(''); const [reviewer, setReviewer] = useState(''); const [reviser, setReviser] = useState(''); const [additionalReviewers, setAdditionalReviewers] = useState<string[]>([]);
  const [autoReview, setAutoReview] = useState(false); const [structured, setStructured] = useState(false); const [manualBatch, setManualBatch] = useState(false); const [autoRetrieval, setAutoRetrieval] = useState(false);
  const [instruction, setInstruction] = useState('依据当前章节和本书设定续写，保持人物性格与叙事视角。');
  // A prompt-library template can be dropped into the instruction field.
  useEffect(() => { if (fill?.text) setInstruction(fill.text); }, [fill?.token]);
  const [tasks, setTasks] = useState<AITask[]>([]); const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const mounted = useRef(true), scope = useRef(projectId), operation = useRef<{ projectId: string; id: string } | null>(null);
  // 记录已消费的「填入写作要求」标记，避免 projectId 变化时被 localStorage 里的旧文本覆盖。
  const fillConsumed = useRef<number | null>(null);
  scope.current = projectId;
  const isCurrent = (targetProjectId: string) => mounted.current && scope.current === targetProjectId;
  const localTasks = (next: AITask[], targetProjectId: string) => next.filter(t => t.projectId === targetProjectId && (t.mode === 'write' || t.mode === 'review' || t.mode === 'revise'));
  const modeLabel = (mode: AITask['mode']) => mode === 'write' ? '正文候选' : mode === 'revise' ? '修订候选' : '审稿报告';
  const refresh = async (targetProjectId = projectId) => { const next = localTasks(await window.writer.aiTasks(targetProjectId), targetProjectId); if (isCurrent(targetProjectId)) setTasks(next); return next; };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current = null; }; }, []);
  useEffect(() => { let disposed = false; let timer: ReturnType<typeof setTimeout>;
    setTasks([]); setSelected(''); setBusy(false); setError(''); setMessage(''); operation.current = null;
    const poll = async () => { try { const next = localTasks(await window.writer.aiTasks(projectId), projectId); if (!disposed && isCurrent(projectId)) { setTasks(next); timer = setTimeout(poll, next.some(t => t.status === 'running' || workflowPending(t)) ? 800 : 4000); } } catch (e) { if (!disposed && isCurrent(projectId)) { setError(String(e)); timer = setTimeout(poll, 4000); } } };
    void poll(); return () => { disposed = true; clearTimeout(timer); };
  }, [projectId]);
  useEffect(() => {
    const prompt = localStorage.getItem(`ai-instruction:${projectId}`);
    // 「填入写作要求」带来的文本必须优先：以前这个 effect 会用 localStorage 覆盖它，导致粘贴的模板被静默丢弃。
    if (fill?.text && fillConsumed.current !== fill.token) { fillConsumed.current = fill.token; setInstruction(fill.text); }
    else setInstruction(prompt || '依据当前章节和本书设定续写，保持人物性格与叙事视角。');
    setAutoReview(localStorage.getItem(`ai-auto-review:${projectId}`) === 'true'); setStructured(localStorage.getItem(`ai-structured-review:${projectId}`) === 'true'); setManualBatch(localStorage.getItem(`ai-manual-batch:${projectId}`) === 'true'); setAutoRetrieval(localStorage.getItem(`ai-auto-retrieval:${projectId}`) === 'true');
    const saved = localStorage.getItem(`ai-models:${projectId}`);
    setWriter(''); setReviewer(''); setReviser(''); setAdditionalReviewers([]);
    if (saved) { try { const value = JSON.parse(saved); setWriter(typeof value.writer === 'string' ? value.writer : ''); setReviewer(typeof value.reviewer === 'string' ? value.reviewer : ''); setReviser(typeof value.reviser === 'string' ? value.reviser : ''); setAdditionalReviewers(Array.isArray(value.additionalReviewers) ? value.additionalReviewers.filter((id: unknown): id is string => typeof id === 'string').slice(0, 2) : []); } catch {} }
  }, [projectId]);
  const saveModelChoices = (next: { writer: string; reviewer: string; reviser: string; additionalReviewers: string[] }) => localStorage.setItem(`ai-models:${projectId}`, JSON.stringify(next));
  const choose = (kind: 'writer' | 'reviewer' | 'reviser', id: string) => { if (busy || running) return; if (kind === 'writer') setWriter(id); else if (kind === 'reviewer') setReviewer(id); else setReviser(id); saveModelChoices({ writer, reviewer, reviser, additionalReviewers, [kind]: id }); };
  const chooseAdditional = (next: string[]) => { if (busy || running) return; setAdditionalReviewers(next); saveModelChoices({ writer, reviewer, reviser, additionalReviewers: next }); };
  const run = async (action: () => Promise<void>) => {
    const targetProjectId = projectId;
    if (!isCurrent(targetProjectId) || operation.current) return false;
    const active = { projectId: targetProjectId, id: crypto.randomUUID() }; operation.current = active;
    setBusy(true); setError(''); setMessage('');
    try { await action(); return isCurrent(targetProjectId) && operation.current === active; } catch (e) { if (isCurrent(targetProjectId) && operation.current === active) setError(String(e)); return false; }
    finally { if (isCurrent(targetProjectId) && operation.current === active) { operation.current = null; setBusy(false); } }
  };
  const currentTasks = localTasks(tasks, projectId);
  const running = currentTasks.some(t => t.status === 'running' || workflowPending(t));
  const task = currentTasks.find(t => t.id === selected) ?? currentTasks[0];
  const activeWorkflow = currentTasks.find(t => t.mode === 'write' && workflowPending(t));
  const taskInActiveWorkflow = !!activeWorkflow && (task?.id === activeWorkflow.id || autoReviews(activeWorkflow).some(review => review.taskId === task?.id));
  const reviewQueue = [reviewer, ...additionalReviewers];
  const validReviewQueue = reviewQueue.every(id => !!id && connections.some(connection => connection.id === id)) && new Set(reviewQueue).size === reviewQueue.length;
  // Reports of the same text version (one candidate, or one saved chapter) can be compared side by side.
  const reportScope = (item: AITask) => `${item.chapterPath}\u0000${item.sourceHash}\u0000${item.mode === 'write' ? item.id : item.reviewTaskId ?? ''}`;
  const scopeReports = task ? currentTasks.filter(item => item.mode === 'review' && item.reviewFormat === 'issues' && item.status === 'complete' && reportScope(item) === reportScope(task)) : [];
  const mergedReports = scopeReports.length > 1 ? mergeReportIssues(scopeReports.map(item => {
    let issues: ReturnType<typeof parseReview>['issues'] = [];
    try { issues = parseReview(item.text, item.sourceText, item.context).issues; } catch { issues = []; }
    return { taskId: item.id, label: `${item.connection.name} / ${item.connection.model}`, issues };
  })) : null;
  const ready = !busy && !blocked && !running && manuscript?.projectId === projectId && manuscript.managed;
  const currentCitationHits = citationHits.filter(hit => hit.projectId === projectId && hit.corpus === 'canon' && hit.confirmed);
  const start = (mode: 'write' | 'review', candidate?: AITask) => {
    if (!ready || !manuscript || manuscript.projectId !== projectId || (candidate && candidate.projectId !== projectId)) return;
    const references = candidate ? (candidate.knowledgeCitations ?? []).map(citationReference) : currentCitationHits.map(citationReference);
    const reviewIds = [reviewer, ...additionalReviewers].filter(Boolean);
    const request: AIRequest = { projectId, chapterPath: manuscript.path, sourceHash: manuscript.hash, mode, connectionId: mode === 'write' ? writer : reviewer, instruction: mode === 'write' ? instruction : '检查错别字、语病、角色行为及世界观冲突，逐项引用原句与依据；资料不足时明确列出未检查项。', reviewTaskId: candidate?.id, reviewFormat: mode === 'review' && structured ? 'issues' : 'text', ...(mode === 'write' && autoReview ? reviewQueue.length === 1 ? { autoReviewConnectionId: reviewer } : { autoReviewConnectionIds: [...reviewQueue] } : {}), ...(!references.length && autoRetrieval ? { autoRetrieval: { mode: 'hybrid' as const, topK: 5 } } : {}), ...(references.length ? { knowledgeCitations: references } : {}) };
    const batchReview = mode === 'review' && manualBatch && reviewIds.length > 1;
    void run(async () => {
      if (mode === 'write' && autoReview && !validReviewQueue) throw new Error('请选择完整且不重复的审稿模型连接，最多三个');
      if (batchReview && !validReviewQueue) throw new Error('手动批量审稿需要完整且不重复的审稿模型连接，最多三个');
      if (!candidate && (currentCitationHits.length !== citationHits.length || references.length > 10)) throw new Error('检索依据与本书正式内容不一致，请清空后重新选择，最多引用10段');
      const next = batchReview
        ? await window.writer.startReviewBatch({ projectId, chapterPath: manuscript.path, sourceHash: manuscript.hash, connectionIds: reviewIds, ...(candidate ? { reviewTaskId: candidate.id } : {}), reviewFormat: structured ? 'issues' : 'text', instruction: '检查错别字、语病、角色行为及世界观冲突，逐项引用原句与依据；资料不足时明确列出未检查项。', ...(references.length ? { knowledgeCitations: references } : {}) })
        : await window.writer.startAI(request);
      if (!isCurrent(request.projectId)) return;
      if (next.projectId !== request.projectId) throw new Error('AI 任务返回的小说不一致，本次结果未载入');
      setSelected(next.id); await refresh(request.projectId);
      if (batchReview) setMessage(`已按 ${reviewIds.length} 个审稿模型依次审阅${candidate ? '该候选' : '已保存章节'}，各模型的报告独立保存，可在下方合并对照`);
    });
  };
  const startRevise = (report: AITask, issueIds: string[]) => {
    if (!ready || !manuscript || manuscript.projectId !== projectId) return;
    const connectionId = reviser || reviewer;
    if (!connectionId) { setError('请先选择修订模型连接'); return; }
    if (manuscript.path !== report.chapterPath || manuscript.hash !== report.sourceHash) { setError('请先打开该报告对应的章节版本，再按问题生成修订候选'); return; }
    void run(async () => {
      const next = await window.writer.startAI({ projectId, chapterPath: report.chapterPath, sourceHash: report.sourceHash, mode: 'revise', connectionId,
        reviewTaskId: report.id, issueIds, instruction: '按所选审稿意见修订正文；只修改被点名的问题，其余文字与段落保持原样。' });
      if (!isCurrent(projectId)) return;
      setSelected(next.id); await refresh(projectId);
      if (isCurrent(projectId)) setMessage(`已生成修订候选（${issueIds.length} 个问题）；原正文未改动，需你确认后再另存`);
    });
  };
  const picker = (label: string, value: string, kind: 'writer' | 'reviewer' | 'reviser') => {
    const selected = connections.find(c => c.id === value);
    return <label><span className="model-picker-heading">{selected && <ProviderBadge baseUrl={selected.baseUrl} adapter={selected.adapter} />}{label}</span><select aria-label={label} value={value} disabled={busy || running} onChange={e => choose(kind, e.target.value)}><option value="">选择模型连接</option>{connections.map(c => <option key={c.id} value={c.id} disabled={kind === 'reviewer' && additionalReviewers.includes(c.id)}>{c.name} · {c.model}</option>)}</select></label>;
  };
  return <section className="ai-page ai-writing-page"><header className="ai-heading"><div><small>WRITING & REVIEW</small><h1>AI 写作与审稿</h1><p>{title} · {manuscript?.path ?? '请先在写作空间打开章节'}</p></div><button onClick={onSettings}>配置模型连接</button></header>
    {error && <div className="error" role="alert">{error}</div>}{message && <p role="status">{message}</p>}
    <div className="ai-columns"><aside className="ai-panel ai-form"><h2>本书工作流</h2>{picker('写作模型', writer, 'writer')}{picker('审稿模型', reviewer, 'reviewer')}{picker('修订模型', reviser, 'reviser')}
      <div className="ai-review-queue" aria-label="本书自动审稿模型队列">{additionalReviewers.map((id, index) => <div className="ai-review-slot" key={index}><label>追加审稿模型 {index + 2}<select aria-label={`追加审稿模型 ${index + 2}`} value={id} disabled={busy || running} onChange={e => chooseAdditional(additionalReviewers.map((value, position) => position === index ? e.target.value : value))}><option value="">选择模型连接</option>{connections.map(connection => <option key={connection.id} value={connection.id} disabled={connection.id === reviewer || additionalReviewers.some((value, position) => position !== index && value === connection.id)}>{connection.name} · {connection.model}</option>)}</select></label><button aria-label={`移除审稿模型 ${index + 2}`} disabled={busy || running} onClick={() => chooseAdditional(additionalReviewers.filter((_, position) => position !== index))}>移除</button></div>)}<button disabled={busy || running || additionalReviewers.length >= 2} onClick={() => chooseAdditional([...additionalReviewers, ''])}>添加审稿模型</button><p>最多三个不同连接，按上方顺序自动审稿。手动审稿使用第一项“审稿模型”。</p></div>
      <label className="ai-check"><input type="checkbox" aria-label="生成后自动送审" checked={autoReview} disabled={busy || running} onChange={e => { setAutoReview(e.target.checked); localStorage.setItem(`ai-auto-review:${projectId}`, String(e.target.checked)); }} />生成后自动送审（额外 {reviewQueue.length} 次模型调用）</label>
      {autoReview && !validReviewQueue && <p className="notice">请补齐每一项审稿模型；同一连接不能重复选择。</p>}
      <label className="ai-check"><input type="checkbox" aria-label="结构化审稿" checked={structured} disabled={busy || running} onChange={e => { setStructured(e.target.checked); localStorage.setItem(`ai-structured-review:${projectId}`, String(e.target.checked)); }} />手动审稿返回可逐项采纳的建议</label>
      <label className="ai-check"><input type="checkbox" aria-label="自动附带检索依据" checked={autoRetrieval} disabled={busy || running} onChange={e => { setAutoRetrieval(e.target.checked); localStorage.setItem(`ai-auto-retrieval:${projectId}`, String(e.target.checked)); }} />自动附带本书正式依据（最多 5 段，未手选时生效）</label>
      <label className="ai-check"><input type="checkbox" aria-label="手动审稿使用全部审稿模型" checked={manualBatch} disabled={busy || running} onChange={e => { setManualBatch(e.target.checked); localStorage.setItem(`ai-manual-batch:${projectId}`, String(e.target.checked)); }} />手动审稿也使用全部 {reviewQueue.length} 个审稿模型（依次执行，各出一份报告）</label>
      {manualBatch && !validReviewQueue && <p className="notice">手动批量审稿需要完整且不重复的审稿模型；同一连接不能重复选择。</p>}
      <label>写作要求<textarea aria-label="写作要求" value={instruction} maxLength={20000} onChange={e => { setInstruction(e.target.value); localStorage.setItem(`ai-instruction:${projectId}`, e.target.value); }} /></label>
      <section className="ai-citation-selection" aria-label="本书选定检索依据"><h3>本书检索依据 · {currentCitationHits.length} 段</h3>
        <p>主进程会复核，未通过不会调用模型。当前选择用于下一次正文生成或审阅已保存章节；审阅候选沿用该候选的任务依据。</p>
        {!!currentCitationHits.length ? <ol className="ai-citation-list">{currentCitationHits.map(hit => <li key={hit.id}><details><summary>{hit.sourceLabel} · 段落 {paragraphRange(citationReference(hit))} · 版本 {hit.sourceHash.slice(0, 12)}</summary><small>来源：{hit.sourcePath}</small><pre>{hit.text}</pre></details></li>)}</ol> : <p>尚未选择检索依据。</p>}
        <div className="actions"><button disabled={busy || !currentCitationHits.length} onClick={onClearCitations}>清空检索依据</button><button disabled={busy} onClick={onKnowledge}>选择检索依据</button></div>
      </section>
      <div className="actions"><button className="primary" disabled={!ready || !writer || !instruction.trim() || (autoReview && !validReviewQueue)} onClick={() => start('write')}>生成正文候选</button><button disabled={!ready || !reviewer} onClick={() => start('review')}>审阅已保存章节</button></div>
      <p>发送当前已保存章节、本书预设与世界观、人物笔记、启用角色卡及选中文风。不会发送其他小说。</p>
      {blocked && <p className="notice">请先保存正文与创作资料，再发起 AI 请求。</p>}
      <p>候选完整结束后，按启动时固定的模型队列依次审稿，分别保留结构化报告。某个模型失败会继续下一项；停止流程会取消后续调用。原文或依据已变化时不继续送审，不自动改写正文。</p>
      <h2>本书最近任务</h2><div className="ai-history">{currentTasks.map(t => <button key={t.id} className={task?.id === t.id ? 'active' : ''} onClick={() => setSelected(t.id)}>{modeLabel(t.mode)} · {labels[t.status]}<small>{t.connection.name} · {new Date(t.createdAt).toLocaleString()}<br />{t.chapterPath}</small></button>)}</div>
    </aside><article className="ai-panel ai-result">{task ? <><header><h2>{modeLabel(task.mode)} · {labels[task.status]}</h2><small>{task.connection.name} / {task.connection.model}</small></header>
      {task.error && <p className="notice">{task.error}</p>}
      {task.autoReviews && <section className="notice ai-auto-reviews" aria-label="自动多模型审稿"><h3>自动审稿 · {task.autoReviews.length} 个模型</h3><ol>{task.autoReviews.map((review, index) => <li key={review.connection.id}><strong>{index + 1}. {review.connection.name} / {review.connection.model}</strong><span>{reviewLabels[review.status]}</span>{review.error && <p>{review.error}</p>}{review.taskId && <button aria-label={`查看自动审稿报告 ${index + 1} · ${review.connection.name}`} onClick={() => setSelected(review.taskId!)}>查看审稿报告</button>}</li>)}</ol></section>}
      {task.autoReview && <div className="notice">自动送审：{reviewLabels[task.autoReview.status]} · {task.autoReview.connection.name} / {task.autoReview.connection.model}<p>{task.autoReview.error}</p>{task.autoReview.taskId && <button onClick={() => setSelected(task.autoReview!.taskId!)}>查看自动审稿报告</button>}</div>}
      {activeWorkflow && <div className="notice ai-workflow-running">正在执行本书写作与审稿流程。<button disabled={busy} onClick={() => void run(async () => { await window.writer.cancelAI(projectId, activeWorkflow.id); await refresh(); })}>停止整条写审流程</button></div>}
      {task.mode === 'review' && <p className="notice">报告对应发送时的正文与设定。修改正文、人物或世界观后，请重新送审。</p>}
      {task.mode === 'revise' && <p className="notice">修订候选只针对所选问题生成，其他文字应保持原样；它不会自动写回正文，也不会自动复审。<br />来源报告：{task.reviewTaskId} · 问题：{task.reviseIssueIds?.join('、')}</p>}
      {task.autoRetrieval && <p className="notice">自动检索：请求 {task.autoRetrieval.requested} · 实际 {task.autoRetrieval.used} · 附带 {task.autoRetrieval.hits} 段{task.autoRetrieval.warning ? `；${task.autoRetrieval.warning}` : ''}</p>}
      {(manuscript?.path !== task.chapterPath || manuscript?.hash !== task.sourceHash || blocked) && <p className="notice">这是生成时版本的结果；当前章节或未保存修改与它不一致。</p>}
      {mergedReports && <details className="ai-merged" open><summary>同版本多报告合并 · {mergedReports.reportCount} 份报告 / {mergedReports.issueCount} 条意见 / 冲突 {mergedReports.conflictCount} 条</summary>
        <p className="notice">合并视图只用于对照：不投票、不合并 issue 序号，采纳与另存仍按单份报告分别进行，原稿保持不变。</p>
        <ol>{mergedReports.clusters.map(cluster => <li key={cluster.key} className={cluster.conflict ? 'merged-conflict' : ''}>
          <p><b>{cluster.conflict ? '意见冲突' : '同类意见'}</b> · 原句：{cluster.quote}</p>
          {cluster.members.map(member => <div className="merged-member" key={`${member.taskId}:${member.issueId}`}>
            <small>{member.label} · {member.issueId} · {member.category}{member.limitation ? ` · ${member.limitation}` : ''}</small>
            <p>建议：{member.replacement || '（删除此处文字）'} —— {member.reason}</p>
            <button disabled={busy || running} onClick={() => setSelected(member.taskId)}>查看这份报告</button>
          </div>)}
        </li>)}</ol>
      </details>}
      <pre aria-label="AI 输出">{task.text || (task.status === 'running' ? '正在等待模型正文（思考模型可能较慢）…' : '未收到正文')}</pre>
      {task.mode === 'review' && task.reviewFormat === 'issues' && task.status === 'complete' && <ReviewChanges key={task.id} task={task} disabled={!ready} onRevise={ids => startRevise(task, ids)} onExport={(ids, guard) => run(async () => { const saved = await window.writer.exportReviewEdits(projectId, task.id, ids, guard); if (isCurrent(projectId)) setMessage(`已另存修订稿 ${saved.path}，原正文保留${saved.warnings.length ? `；${saved.warnings.join('；')}` : ''}`); try { await onExport(projectId); } catch { if (isCurrent(projectId)) setError('修订稿已另存，章节列表刷新失败，请返回写作空间重新扫描'); } })} />}
      <div className="actions">{task.status === 'running' && !taskInActiveWorkflow && <button disabled={busy} onClick={() => void run(async () => { await window.writer.cancelAI(projectId, task.id); await refresh(); })}>停止生成</button>}
        <button disabled={busy || !task.text} onClick={() => void run(async () => { const text = task.mode === 'write' ? task.text.split(/\r?\n/).filter(p => p.trim()).map(p => `　　${p.trimStart()}`).join('\n\n') : task.text; await window.writer.copyText(text); if (isCurrent(projectId)) setMessage('AI 结果已复制'); })}>复制结果</button>
        {['write', 'revise'].includes(task.mode) && <><button disabled={!ready || task.status !== 'complete' || !reviewer || task.mode !== 'write'} onClick={() => start('review', task)}>用审稿模型检查此候选</button><button disabled={!ready || task.status !== 'complete'} onClick={() => void run(async () => { const saved = await window.writer.exportAI(projectId, task.id); await onExport(projectId); if (isCurrent(projectId)) setMessage(`已另存为 ${saved.path}，原正文保留`); })}>候选另存 DOCX</button></>}
      </div><details><summary>查看发送内容与版本依据</summary><small>小说 ID：{task.projectId}<br />正文哈希：{task.sourceHash}<br />设定哈希：{task.contextHash}<br />检索依据指纹：{task.citationFingerprint ?? '无检索依据'}</small><section className="ai-task-citations" aria-label="任务检索依据"><h3>本次任务引用 · {task.knowledgeCitations?.length ?? 0} 段</h3>{!!task.knowledgeCitations?.length && <ol className="ai-citation-list">{task.knowledgeCitations.map(citation => <li key={citation.id}><small>来源：{citation.sourcePath}<br />段落：{paragraphRange(citation)} · 版本：{citation.sourceHash}<br />引用 ID：{citation.id}</small></li>)}</ol>}</section><pre>{task.instruction}\n\n{task.context || '未提供本书设定'}\n\n{task.sourceText}</pre></details><p>输出与报告保存在本机本书历史区。审稿建议由作者判断；报告不会修改正文。</p></> : <div className="ai-empty"><h2>让写作与审稿各司其职</h2><p>配置模型，保存章节，再生成候选稿或检查已写内容。</p></div>}</article></div>
  </section>;
}
