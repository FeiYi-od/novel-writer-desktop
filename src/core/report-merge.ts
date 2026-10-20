import type { ReviewIssue } from './review';

/** One issue exactly as one report stated it. Report identity is part of the member, so an
 * `issue-1` from two different reports never collapses into a single row. */
export interface MergedIssue {
  taskId: string; label: string; issueId: string;
  category: string; quote: string; replacement: string; reason: string; limitation: string;
}
export interface MergedCluster {
  key: string; quote: string; members: MergedIssue[];
  /** True when reports disagree on the replacement or category for the same sentence. */
  conflict: boolean; replacements: string[]; categories: string[];
}
export interface MergedReports {
  clusters: MergedCluster[]; reportCount: number; issueCount: number; conflictCount: number;
}
export interface ReportIssues { taskId: string; label: string; issues: ReviewIssue[] }

const normalize = (text: string) => text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();

/**
 * Groups every report's issues by the sentence they quote, in first-appearance order.
 * This is a reading aid only: it never votes, never drops an opinion, and never renumbers
 * issues. Adoption still runs per report, with that report's own fingerprint and guard.
 */
export function mergeReportIssues(reports: ReportIssues[]): MergedReports {
  const order: string[] = [];
  const groups = new Map<string, MergedIssue[]>();
  let issueCount = 0;
  for (const report of reports) {
    for (const issue of report.issues) {
      issueCount++;
      const key = normalize(issue.quote);
      if (!key) continue;
      if (!groups.has(key)) { groups.set(key, []); order.push(key); }
      groups.get(key)!.push({ taskId: report.taskId, label: report.label, issueId: issue.id,
        category: issue.category, quote: issue.quote, replacement: issue.replacement, reason: issue.reason, limitation: issue.limitation });
    }
  }
  const clusters = order.map(key => {
    const members = groups.get(key)!;
    // Conflicts are judged across reports only: one report repeating itself is not a disagreement.
    const perReport = new Map<string, MergedIssue>();
    for (const member of members) if (!perReport.has(member.taskId)) perReport.set(member.taskId, member);
    const judges = [...perReport.values()];
    const replacements = [...new Set(judges.map(member => normalize(member.replacement)))];
    const categories = [...new Set(judges.map(member => member.category))];
    const conflict = replacements.length > 1 || categories.length > 1;
    return { key, quote: members[0].quote, members, conflict, replacements, categories };
  });
  return { clusters, reportCount: reports.length, issueCount, conflictCount: clusters.filter(cluster => cluster.conflict).length };
}
