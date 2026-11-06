import { z } from 'zod';
import type { UiDraft, WorldCardEditRequest } from '../shared/contracts';

const draftSchema = z.object({
  schemaVersion: z.literal(1),
  target: z.object({ projectId: z.uuid(), book: z.string().min(1).max(60), entryId: z.string().min(1).max(500), expectedHash: z.string().regex(/^[a-f0-9]{64}$/u), comment: z.string().max(100000), content: z.string().max(1000000), keys: z.array(z.string().max(100000)).max(10000) }).strict(),
  name: z.string().max(100000), content: z.string().max(1000000), keys: z.string().max(1000000)
}).strict();

export interface WorldCardDraft { schemaVersion: 1; target: WorldCardEditRequest; name: string; content: string; keys: string }

export function parseWorldCardDraft(projectId: string, draft: UiDraft): WorldCardDraft {
  if (draft.page !== 'world-card' || typeof draft.values.payload !== 'string') throw new Error('设定卡草稿格式不受支持，原草稿已保留');
  let input: unknown;
  try { input = JSON.parse(draft.values.payload); } catch { throw new Error('设定卡草稿损坏，原草稿已保留'); }
  const result = draftSchema.safeParse(input);
  if (!result.success || result.data.target.projectId !== projectId) throw new Error('设定卡草稿损坏、版本不受支持或属于另一部小说，原草稿已保留');
  return result.data;
}

export function worldCardDraftPayload(target: WorldCardEditRequest, name: string, content: string, keys: string): Record<string, string> {
  return { payload: JSON.stringify({ schemaVersion: 1, target, name, content, keys } satisfies WorldCardDraft) };
}
