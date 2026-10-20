import { useEffect, useMemo, useRef, useState } from 'react';
import type { AITask, ReviewDecisionSnapshot, ReviewExportGuard, ReviewIssueStatus } from '../../shared/contracts';
import { applyReviewEdits, parseReview } from '../../core/review';
import { reviewReportIdentityText } from '../../core/review-identity';
import { exitSaves, useSaveBeforeExit } from './save-before-exit';

const statusLabels: Record<ReviewIssueStatus, string> = { pending: '待处理', accepted: '待采纳', ignored: '忽略', 'false-positive': '误报', applied: '已另存采纳' };
const editableStatuses = ['pending', 'accepted', 'ignored', 'false-positive'] as const;
const adoptable = (status: ReviewIssueStatus) => status === 'pending' || status === 'accepted';
const errorText = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^(?:Error: )?Error invoking remote method '[^']+': (?:Error: )?/, '');

export function ReviewChanges({ task, disabled, onExport, onRevise }: { task: AITask; disabled: boolean; onExport: (ids: string[], guard: ReviewExportGuard) => Promise<boolean>; onRevise?: (ids: string[]) => void }) {
  // A task ID alone does not identify an immutable report. Polling can replace its saved contents.
  const signature = reviewReportIdentityText(task);
  const [selectedState, setSelected] = useState<{ signature: string; ids: string[] }>({ signature, ids: [] });
  const [loaded, setLoaded] = useState<{ signature: string; value: ReviewDecisionSnapshot } | null>(null);
  const [failure, setFailure] = useState<{ signature: string; text: string } | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const mounted = useRef(true), pending = useRef(0), generation = useRef(0), scope = useRef(signature);
  if (scope.current !== signature) { scope.current = signature; generation.current++; }
  const result = useMemo(() => { try { return { report: parseReview(task.text, task.sourceText, task.context), error: '' }; } catch (e) { return { report: null, error: errorText(e) }; } }, [signature]);
  const selected = selectedState.signature === signature ? selectedState.ids : [];
  const snapshot = loaded?.signature === signature ? loaded.value : null;
  const error = failure?.signature === signature ? failure.text : '';
  useSaveBeforeExit('审稿问题处理', () => ({ dirty: false, busy: pending.current > 0 }));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const current = (target: { signature: string; generation: number }) => mounted.current && scope.current === target.signature && generation.current === target.generation;
  const begin = () => {
    const target = { signature, generation: ++generation.current };
    pending.current++; setPendingCount(pending.current); setFailure(null);
    // Keep exit protected if the report is switched away while its IPC is still pending.
    const release = exitSaves.register('审稿问题处理', () => ({ dirty: false, busy: true }));
    return { target, finish: () => { release(); pending.current--; if (mounted.current) setPendingCount(pending.current); } };
  };
  const validate = (next: ReviewDecisionSnapshot, expectedFingerprint: string) => {
    const ids = result.report?.issues.map(issue => issue.id) ?? [];
    if (next.projectId !== task.projectId || next.taskId !== task.id || next.reportFingerprint !== expectedFingerprint
      || (next.hash !== '' && !/^[a-f0-9]{64}$/.test(next.hash)) || typeof next.stale !== 'boolean' || typeof next.staleReason !== 'string'
      || next.items.length !== ids.length || new Set(next.items.map(item => item.issueId)).size !== ids.length
      || next.items.some(item => !ids.includes(item.issueId) || !Object.hasOwn(statusLabels, item.status)
        || typeof item.updatedAt !== 'string' || (item.status === 'applied' && (!item.outputPath || !/^[a-f0-9]{64}$/.test(item.outputHash ?? ''))))) {
      throw new Error('问题处理记录与本书报告不一致，请重新读取处理状态。');
    }
    return next;
  };
  const accept = async (next: ReviewDecisionSnapshot, target: { signature: string; generation: number }) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signature));
    const expectedFingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (!current(target)) return;
    const value = validate(next, expectedFingerprint); setLoaded({ signature: target.signature, value });
    setSelected(previous => ({ signature: target.signature, ids: previous.signature === target.signature ? previous.ids.filter(id => value.items.some(item => item.issueId === id && adoptable(item.status))) : [] }));
  };
  const read = async () => {
    if (!result.report || pending.current) return;
    const operation = begin();
    try { const next = await window.writer.reviewDecisions(task.projectId, task.id); if (current(operation.target)) await accept(next, operation.target); }
    catch (e) { if (current(operation.target)) setFailure({ signature, text: errorText(e) }); }
    finally { operation.finish(); }
  };
  useEffect(() => { setSelected({ signature, ids: [] }); }, [signature]);
  useEffect(() => {
    if (!pending.current && loaded?.signature !== signature && failure?.signature !== signature) void read();
  }, [signature, pendingCount]);
  const processing = pendingCount > 0;
  const locked = disabled || processing || !snapshot || snapshot.stale || !!error;
  const change = async (issueId: string, status: Exclude<ReviewIssueStatus, 'applied'>) => {
    if (locked || pending.current || !snapshot) return;
    const request = { projectId: task.projectId, taskId: task.id, issueId, status, reportFingerprint: snapshot.reportFingerprint, expectedHash: snapshot.hash };
    setSelected({ signature, ids: selected.filter(id => id !== issueId) });
    const operation = begin();
    try { const next = await window.writer.setReviewDecision(request); if (current(operation.target)) await accept(next, operation.target); }
    catch (e) { if (current(operation.target)) setFailure({ signature, text: errorText(e) }); }
    finally { operation.finish(); }
  };
  const exportSelection = async () => {
    if (locked || pending.current || !snapshot || !selected.length) return;
    const guard = { reportFingerprint: snapshot.reportFingerprint, expectedHash: snapshot.hash };
    const operation = begin(), ids = [...selected];
    try {
      let success = false, exportFailure = '';
      try { success = await onExport(ids, guard); } catch (e) { exportFailure = errorText(e); }
      if (current(operation.target) && success) setSelected({ signature, ids: [] });
      // A failed response may follow a successful file write. Always reread actual saved decisions.
      const next = await window.writer.reviewDecisions(task.projectId, task.id);
      if (current(operation.target)) await accept(next, operation.target);
      if (exportFailure && current(operation.target)) setFailure({ signature, text: exportFailure });
    } catch (e) { if (current(operation.target)) setFailure({ signature, text: errorText(e) }); }
    finally { operation.finish(); }
  };
  let revised = '', conflict = '';
  if (selected.length && result.report) { try { revised = applyReviewEdits(task.sourceText, result.report.issues, selected); } catch (e) { conflict = errorText(e); } }
  if (!result.report) return <p className="notice">{result.error}</p>;
  return <section className="review-changes" aria-label="审稿问题处理"><h3>逐项核对与采纳</h3><p>{result.report.summary}</p>
    <p>处理状态按本书和本份报告保存。“待采纳”记录作者判断；另存修订稿成功后才标为“已另存采纳”，不会修改原稿或自动确认正史。</p>
    <div className="review-state-tools"><button disabled={processing} onClick={() => void read()}>重新读取处理状态</button>{processing && <span role="status">正在读取或保存审稿处理状态…</span>}</div>
    {error && <p role="alert" className="notice">{error} 请重新读取处理状态后再操作；已有记录保留。</p>}
    {snapshot?.stale && <p role="alert" className="notice">本报告版本已失效：{snapshot.staleReason}。处理记录仅供查看，请核对并重新审稿。</p>}
    {!result.report.issues.length && <p>模型没有列出问题；这不代表已经排除所有错误。</p>}
    {result.report.issues.map(issue => {
      const decision = snapshot?.items.find(item => item.issueId === issue.id), status = decision?.status;
      return <div className="review-issue" key={issue.id}><label><input type="checkbox" aria-label={`采纳建议 ${issue.id}`} checked={selected.includes(issue.id)} disabled={locked || issue.start === null || !status || !adoptable(status)} onChange={e => setSelected({ signature, ids: e.target.checked ? [...selected, issue.id] : selected.filter(id => id !== issue.id) })} />{issue.category} · {issue.start === null ? '需人工定位' : `正文第 ${task.sourceText.slice(0, issue.start).split(/\n\n/).length} 段`}</label>
        <div className="review-decision">{status === 'applied' ? <><strong>已另存采纳</strong><button aria-label={`重新处理 ${issue.id}`} disabled={locked} onClick={() => void change(issue.id, 'pending')}>重新处理</button></> : <label>处理状态<select aria-label={`处理状态 ${issue.id}`} value={status ?? ''} disabled={locked} onChange={e => void change(issue.id, e.target.value as Exclude<ReviewIssueStatus, 'applied'>)}>{!status && <option value="">尚未读取</option>}{editableStatuses.map(value => <option key={value} value={value} disabled={value === 'accepted' && issue.start === null}>{statusLabels[value]}</option>)}</select></label>}
          {decision?.updatedAt && <small>保存时间：{new Date(decision.updatedAt).toLocaleString('zh-CN', { hour12: false })}</small>}
          {status === 'applied' && <small className="review-output">修订稿：{decision!.outputPath}<br />文件版本：{decision!.outputHash}</small>}
        </div>
        <div className="review-diff"><div><small>原句</small><del>{issue.quote}</del></div><div><small>建议</small><ins>{issue.replacement || '（删除此处文字）'}</ins></div></div>
        <p>{issue.reason}</p>{issue.evidence && <p>引用依据：{issue.evidence}</p>}{issue.limitation && <p className="notice">{issue.limitation}</p>}
      </div>;
    })}
    {conflict && <p role="alert" className="notice">{conflict}</p>}
    {revised && <details><summary>预览选中修改后的全文</summary><pre aria-label="审稿修订预览">{revised}</pre></details>}
    {task.reviewTaskId ? <p>本报告审阅的是 AI 候选。只采纳勾选项，另存基础段落 DOCX；使用宋体五号和真实段首空格，不沿用原章节的标题或粗斜体，原稿保留。</p> : <p>本报告审阅的是已保存章节。另存时复核原文、设定和文档结构，保留应用支持的标题、粗斜体、换行、空段及未选文字；新增文字沿用原句首字的粗斜体。无法安全定位的修改会拒绝另存，原稿保留。</p>}
    <p>上方预览仅展示文字。正文默认宋体五号、两个可复制的全角段首空格；复杂外部 Word/WPS 文档仍需先另存应用副本。</p>
    <button disabled={locked || !selected.length || !!conflict} onClick={() => void exportSelection()}>采纳选中建议并另存 DOCX</button>
    {onRevise && <div className="review-revise"><button disabled={locked || !selected.length} onClick={() => onRevise(selected)}>用修订模型生成候选（{selected.length} 项）</button><p>只把勾选且已定位的问题交给修订模型，产出一份新候选；原正文不改，也不会自动复审或循环改写。</p></div>}
  </section>;
}
