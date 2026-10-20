import type { AITask } from '../shared/contracts';

/** Stable identity shared by the main process and the displayed report. */
export function reviewReportIdentityText(task: AITask): string {
  const profile = task.connection;
  // Live tasks and schema-parsed history may have different property insertion order.
  const connection = { id: profile.id, name: profile.name, model: profile.model, baseUrl: profile.baseUrl,
    adapter: profile.adapter, thinking: profile.thinking, timeoutSeconds: profile.timeoutSeconds,
    contextWindow: profile.contextWindow, maxOutputTokens: profile.maxOutputTokens, tokenParameter: profile.tokenParameter };
  const citations = task.knowledgeCitations?.map(ref => ({ id: ref.id, projectId: ref.projectId, corpus: ref.corpus,
    sourcePath: ref.sourcePath, sourceHash: ref.sourceHash, startParagraph: ref.startParagraph, endParagraph: ref.endParagraph }));
  const style = task.styleSource;
  const styleSource = style ? { name: style.name, sourceIds: style.sourceIds,
    sourceHashes: Object.fromEntries(Object.entries(style.sourceHashes).sort(([left], [right]) => left.localeCompare(right))),
    sampled: style.sampled, sampleCharacters: style.sampleCharacters, totalCharacters: style.totalCharacters,
    metrics: { characters: style.metrics.characters, paragraphs: style.metrics.paragraphs,
      meanSentenceLength: style.metrics.meanSentenceLength, meanParagraphLength: style.metrics.meanParagraphLength,
      dialogueRatio: style.metrics.dialogueRatio, firstPersonPerThousand: style.metrics.firstPersonPerThousand } } : null;
  return JSON.stringify({ schemaVersion: task.schemaVersion, id: task.id, projectId: task.projectId, mode: task.mode,
    status: task.status, reviewFormat: task.reviewFormat ?? null, text: task.text, sourceText: task.sourceText,
    sourceHash: task.sourceHash, chapterPath: task.chapterPath, reviewTaskId: task.reviewTaskId ?? null,
    contextHash: task.contextHash, context: task.context, knowledgeCitations: citations ?? null,
    citationFingerprint: task.citationFingerprint ?? null, reviewDocumentHash: task.reviewDocumentHash ?? null,
    connection, instruction: task.instruction, createdAt: task.createdAt, finishReason: task.finishReason, styleSource });
}
