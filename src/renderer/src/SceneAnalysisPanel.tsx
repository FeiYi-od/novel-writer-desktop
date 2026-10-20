import { useMemo } from 'react';
import type { Manuscript } from '../../shared/contracts';
import { copyableText } from '../../core/typography';
import { analyzeScene, dominantTrait } from '../../core/scene-analysis';

/** Scene reading for the chapter being edited: every number is counted, no model call. */
export function SceneAnalysisPanel({ document, title, onClose }: { document: Manuscript | null; title: string; onClose: () => void }) {
  const report = useMemo(() => (document && typeof document.content !== 'string' ? analyzeScene(copyableText(document.content)) : null), [document]);
  const labels: Record<string, string> = { dialogue: '对白为主', action: '动作推进', daily: '日常叙述', mixed: '混合场景' };
  return <div className="modal-overlay"><section className="book-modal scene-modal" role="dialog" aria-modal="true" aria-label="场景分析">
    <header><div><h2>场景分析</h2><p>对当前章节做客观统计：场景类型、对白与动作占比、段落节奏，然后给出可执行的修改建议。</p></div></header>
    {!report && <p>先在写作空间打开一个章节。</p>}
    {report && report.metrics.chars === 0 && <p>这一章还没有正文内容，写几句再来分析。</p>}
    {report && report.metrics.chars > 0 && <>
      <p role="status" className="notice">{title}：{labels[report.metrics.type]}｜{dominantTrait(report.metrics)}</p>
      <table className="scene-table"><tbody>
        <tr><th>字数</th><td>{report.metrics.chars}</td><th>段均字数</th><td>{report.metrics.averageParagraph}</td></tr>
        <tr><th>对白占比</th><td>{Math.round(report.metrics.dialogueRatio * 100)}%</td><th>对白句</th><td>{report.metrics.speechLines}</td></tr>
        <tr><th>提示语</th><td>{report.metrics.speechTags}</td><th>动作句</th><td>{report.metrics.actionSentences}</td></tr>
        <tr><th>“地”状语</th><td>{report.metrics.adverbs}</td><th>模糊词</th><td>{report.metrics.hedges}</td></tr>
      </tbody></table>
      <h3>修改建议</h3>
      {report.suggestions.length ? <ul className="scene-suggestions">{report.suggestions.map(item => <li key={item}>{item}</li>)}</ul> : <p>这一章暂时没有触发阈值的问题。建议基于统计规则，不是评价好坏。</p>}
    </>}
    <footer><button onClick={onClose}>关闭</button></footer>
  </section></div>;
}
