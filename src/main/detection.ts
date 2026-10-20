import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { copyableText } from '../core/typography';
import type { DetectionBatchRequest, DetectionBatchState, DetectionConnectionTest, DetectionQuotaRequest, DetectionReport, DetectionUsageSnapshot } from '../shared/contracts';
import type { Workspace } from './workspace';
import { hashText, normalizeBaseUrl, type AIConnections } from './ai-connections';
import { DetectionUsageStore, type DetectionUsageIdentity } from './detection-usage';
const ratio = z.number().finite().min(0).max(1);
const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export interface ZhuqueUsage { modelTokens?: number; makersTokens?: number }
const responseSchema = z.object({ status: z.literal('success'), labels_ratio: z.object({ '0': ratio, '1': ratio, '2': ratio }), softmax_confidence: ratio.optional(), segment_labels: z.array(z.object({ text: z.string().max(100000), label: z.number().int().min(0).max(2), conf: ratio })).max(10000).default([]) });
const reportSchema = z.object({ schemaVersion: z.literal(1), id: z.uuid(), projectId: z.uuid(), chapterPath: z.string(), sourceHash: z.string(), provider: z.literal('zhuque-text'), createdAt: z.string(), endpoint: z.string(), humanRatio: ratio, aiRatio: ratio, suspectedRatio: ratio, confidence: ratio.optional(), modelTokens: tokens.optional(), makersTokens: tokens.optional(), usageWarning: z.string().max(2000).optional(), segments: z.array(z.object({ text: z.string(), label: z.number(), confidence: ratio })) });
/** Fixed fictional sentence for explicit connection tests; never a user chapter. */
export const DETECTION_TEST_TEXT = '这是小说编写器用于检查朱雀连接与额度扣减的固定虚构短文，不包含作者的任何正文。';
const UNKNOWN_TOKENS = '服务未返回 Makers 扣减用量，本次消耗记为未知，不能当作零消耗';
const LEDGER_FAILED = '本机朱雀用量记录保存失败，本次请求可能已经扣减额度，请在 Makers 控制台核对';
/** Keep a failed request honest: report the deduction we actually saw, and never imply zero. */
const failureSuffix = (usage: ZhuqueUsage, warnings: string[]) => [
  ...(warnings.includes(LEDGER_FAILED) ? [`；${LEDGER_FAILED}`] : []),
  ...(usage.makersTokens === undefined ? [] : [`；本次实际扣减 ${usage.makersTokens} Token`])
].join('');

export async function zhuqueDetect(baseUrl: string, key: string, text: string, signal: AbortSignal, onUsage?: (value: ZhuqueUsage) => void) {
  if (!text.trim() || text.length > 100000) throw new Error('检测正文需要有内容，单次最多 10 万字符；请拆分过长章节');
  const endpoint = `${normalizeBaseUrl(baseUrl).replace(/\/+$/, '').replace(/\/v1(?:\/providers\/zhuque-text\/classify)?$/, '')}/v1/providers/zhuque-text/classify`;
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ text, is_merge: false }) });
  if (!response.body) throw new Error('朱雀未返回检测数据');
  const reader = response.body.getReader(); const parts: Buffer[] = []; let size = 0;
  try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 4 * 1024 * 1024) throw new Error('朱雀响应超过限制'); parts.push(Buffer.from(value)); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))); } catch { value = null; }
  // These fields have different billing meanings. Missing/invalid fields stay
  // unknown; model usage must never be substituted for Makers deductions.
  const usage: ZhuqueUsage = {};
  if (value && typeof value === 'object') {
    const body = value as Record<string, unknown>;
    for (const [source, target] of [['usage', 'modelTokens'], ['makers_models_usage', 'makersTokens']] as const) {
      const node = body[source], amount = node && typeof node === 'object' ? tokens.safeParse((node as Record<string, unknown>).total_tokens) : null;
      if (amount?.success) usage[target] = amount.data;
    }
  }
  onUsage?.(usage);
  if (!response.ok) {
    if ([401, 403].includes(response.status)) throw new Error(`朱雀认证失败（HTTP ${response.status}），请核对 Makers API Key 与权限`);
    if (response.status === 429) throw new Error('朱雀请求受限（HTTP 429），可能为限流或额度限制，请到 Makers 控制台核对');
    throw new Error(`朱雀接口返回 HTTP ${response.status}，请核对地址、请求参数与服务状态`);
  }
  let parsed: z.infer<typeof responseSchema>;
  try { parsed = responseSchema.parse(value); }
  catch { throw new Error('朱雀响应格式不匹配或检测未成功，未生成有效报告'); }
  return { endpoint, humanRatio: parsed.labels_ratio['0'], aiRatio: parsed.labels_ratio['1'], suspectedRatio: parsed.labels_ratio['2'], confidence: parsed.softmax_confidence, ...usage, segments: parsed.segment_labels.map(s => ({ text: s.text, label: s.label, confidence: s.conf })) };
}

export class DetectionService {
  private running = false;
  private batches = new Map<string, { state: DetectionBatchState; controller: AbortController }>();
  constructor(private directory: string, private connections: AIConnections, private workspace: Workspace, private usageStore = new DetectionUsageStore(directory)) {}
  private folder(id: string) { this.workspace.getProject(z.uuid().parse(id)); return path.join(this.directory, 'detection-reports', id); }
  /** Ledger identity is the saved connection plus a one-way fingerprint of URL and key, so a
   * changed endpoint or credential never inherits another credential's quota history. */
  private async credential(connectionId: string) {
    const { profile, key } = await this.connections.resolve(connectionId);
    const identity: DetectionUsageIdentity = { connectionId: profile.id, credentialFingerprint: hashText(`${profile.baseUrl}\n${key}`) };
    return { profile, key, identity };
  }
  private async finish(identity: DetectionUsageIdentity, attempt: { requestId: string; projectId?: string; at: string }, status: 'success' | 'error', usage: ZhuqueUsage, warnings: string[]) {
    try {
      await this.usageStore.record(identity, { ...attempt, status, ...(usage.modelTokens === undefined ? {} : { modelTokens: usage.modelTokens }), ...(usage.makersTokens === undefined ? {} : { makersTokens: usage.makersTokens }) });
    } catch { warnings.push(LEDGER_FAILED); }
    if (usage.makersTokens === undefined) warnings.push(UNKNOWN_TOKENS);
    return warnings;
  }
  /** Device-local usage only: never an official Tencent balance. */
  async usage(connectionId: string): Promise<DetectionUsageSnapshot> {
    const { identity } = await this.credential(connectionId);
    return this.usageStore.read(identity);
  }
  async configureUsage(request: DetectionQuotaRequest): Promise<DetectionUsageSnapshot> {
    const { identity } = await this.credential(request.connectionId);
    if (identity.credentialFingerprint !== request.credentialFingerprint) throw new Error('朱雀连接或密钥已变化，请重新读取用量后再校准');
    return this.usageStore.configure(identity, {
      monthlyLimit: request.monthlyLimit, expectedHash: request.expectedHash, month: request.month,
      ...(request.accountUsed === undefined ? {} : { accountUsed: request.accountUsed })
    });
  }
  /** Explicit test with fixed fictional text. It may consume quota, so the attempt is persisted
   * before HTTP and finalized afterwards even when the response is unusable. */
  async testConnection(connectionId: string): Promise<DetectionConnectionTest> {
    if (this.running) throw new Error('已有朱雀请求正在进行，请等待当前请求结束后再测试');
    this.running = true;
    try {
      const { profile, key, identity } = await this.credential(connectionId);
      if (!key) throw new Error('请先填写腾讯 EdgeOne Makers API Key');
      normalizeBaseUrl(profile.baseUrl);
      const requestId = randomUUID(), at = new Date().toISOString(), warnings: string[] = [];
      await this.usageStore.begin(identity, { requestId, at });
      let captured: ZhuqueUsage = {};
      let data: Awaited<ReturnType<typeof zhuqueDetect>>;
      try { data = await zhuqueDetect(profile.baseUrl, key, DETECTION_TEST_TEXT, AbortSignal.timeout(60000), value => { captured = value; }); }
      catch (error) {
        await this.finish(identity, { requestId, at }, 'error', captured, warnings);
        if (error instanceof Error) error.message += failureSuffix(captured, warnings);
        throw error;
      }
      await this.finish(identity, { requestId, at }, 'success', captured, warnings);
      const usage = await this.usageStore.read(identity);
      return { provider: 'zhuque-text', checkedAt: new Date().toISOString(), endpoint: data.endpoint,
        humanRatio: data.humanRatio, aiRatio: data.aiRatio, suspectedRatio: data.suspectedRatio, confidence: data.confidence,
        modelTokens: data.modelTokens, makersTokens: data.makersTokens,
        ...(warnings.length ? { usageWarning: warnings.join('；') } : {}), usage };
    } finally { this.running = false; }
  }
  async detect(projectId: string, chapterPath: string, sourceHash: string, connectionId: string): Promise<DetectionReport> {
    this.folder(projectId); if (this.running) throw new Error('已有朱雀检测正在进行，请等待当前请求结束');
    this.running = true;
    try { return await this.detectOne(projectId, chapterPath, sourceHash, connectionId); }
    finally { this.running = false; }
  }
  /** One billable chapter request without the service lock; callers own serialization. */
  private async detectOne(projectId: string, chapterPath: string, sourceHash: string, connectionId: string, external?: AbortSignal): Promise<DetectionReport> {
    const folder = this.folder(projectId);
    const source = await this.workspace.readChapter(projectId, chapterPath);
    if (source.hash !== sourceHash) throw new Error('正文已变化，请重新打开后检测');
    if (typeof source.content === 'string') throw new Error('外部 DOCX 请先另存副本再检测');
    const text = copyableText(source.content);
    // Reject input problems before the ledger records a request, so a malformed call never looks billed.
    if (!text.trim() || text.length > 100000) throw new Error('检测正文需要有内容，单次最多 10 万字符；请拆分过长章节');
    const { profile, key, identity } = await this.credential(connectionId);
    if (!key) throw new Error('请先填写腾讯 EdgeOne Makers API Key');
    normalizeBaseUrl(profile.baseUrl);
    external?.throwIfAborted();
    const requestId = randomUUID(), at = new Date().toISOString();
    await this.usageStore.begin(identity, { requestId, projectId, at });
    try {
      // Last check before a billable request: the source and the credential must still be the same ones.
      if ((await this.workspace.readChapter(projectId, chapterPath)).hash !== sourceHash) throw new Error('正文在检测准备期间已变化，请重新打开后检测');
      if ((await this.credential(connectionId)).identity.credentialFingerprint !== identity.credentialFingerprint) throw new Error('朱雀连接或密钥在检测准备期间已变化，请重新选择后再检测');
      external?.throwIfAborted();
    } catch (error) {
      // Nothing was sent yet, so the pending attempt may be withdrawn instead of counting as consumption.
      await this.usageStore.cancelPending(identity, requestId).catch(() => {});
      throw error;
    }
    const timeout = AbortSignal.timeout(60000);
    const signal = external ? AbortSignal.any([timeout, external]) : timeout;
    let captured: ZhuqueUsage = {}; const warnings: string[] = [];
    let data: Awaited<ReturnType<typeof zhuqueDetect>>;
    try { data = await zhuqueDetect(profile.baseUrl, key, text, signal, value => { captured = value; }); }
    catch (error) {
      await this.finish(identity, { requestId, projectId, at }, 'error', captured, warnings);
      if (error instanceof Error) error.message += failureSuffix(captured, warnings);
      throw error;
    }
    await this.finish(identity, { requestId, projectId, at }, 'success', captured, warnings);
    const report: DetectionReport = { schemaVersion: 1, id: randomUUID(), projectId, chapterPath, sourceHash, provider: 'zhuque-text', createdAt: new Date().toISOString(), ...data,
      ...(warnings.length ? { usageWarning: warnings.join('；') } : {}) };
    try {
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, `${report.id}.json`), JSON.stringify(report, null, 2), { flag: 'wx' });
    } catch {
      throw new Error(`朱雀检测已返回结果，但报告保存失败；本次已按实际用量记录${captured.makersTokens === undefined ? '（扣减未知）' : `（扣减 ${captured.makersTokens} Token）`}，请检查本机可写空间`);
    }
    return report;
  }
  /** Sequential batch over frozen chapter hashes. One chapter's failure never stops the rest, and
   * a stop request aborts only the remaining work; reports already written stay. */
  async batch(projectId: string, request: DetectionBatchRequest): Promise<DetectionBatchState> {
    this.folder(projectId);
    if (this.running) throw new Error('已有朱雀检测正在进行，请等待当前请求结束');
    if (!Array.isArray(request?.items) || request.items.length === 0) throw new Error('请选择至少一个章节再批量检测');
    if (request.items.length > 50) throw new Error('一次最多批量检测 50 个章节，请分批进行');
    const items = request.items.map(item => ({ path: z.string().min(1).max(2000).parse(item?.path), hash: z.string().regex(/^[a-f0-9]{64}$/).optional().parse(item?.hash) }));
    if (new Set(items.map(item => item.path)).size !== items.length) throw new Error('批量检测的章节不能重复');
    const { identity } = await this.credential(request.connectionId);
    if (!identity.credentialFingerprint) throw new Error('请先保存朱雀连接');
    // Validate every source before any billable request starts, and freeze its hash for this run.
    const frozen: { path: string; hash: string }[] = [];
    for (const item of items) {
      const chapter = await this.workspace.readChapter(projectId, item.path);
      if (item.hash && chapter.hash !== item.hash) throw new Error(`${item.path} 已在外部变化，请重新扫描后批量检测`);
      frozen.push({ path: item.path, hash: chapter.hash });
    }
    const controller = new AbortController();
    const state: DetectionBatchState = { projectId, connectionId: request.connectionId, startedAt: new Date().toISOString(),
      running: true, stopped: false, total: frozen.length, completed: 0, created: 0, current: '', failures: [] };
    this.batches.set(projectId, { state, controller });
    this.running = true;
    try {
      for (const item of frozen) {
        if (controller.signal.aborted) { state.stopped = true; break; }
        state.current = item.path;
        try { await this.detectOne(projectId, item.path, item.hash, request.connectionId, controller.signal); state.created++; }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          state.failures.push({ path: item.path, message });
          if (controller.signal.aborted) state.stopped = true;
        }
        state.completed++;
      }
    } finally {
      state.running = false; state.stopped = state.stopped || controller.signal.aborted;
      state.current = ''; state.finishedAt = new Date().toISOString();
      this.running = false;
    }
    return structuredClone(state);
  }
  batchState(projectId: string): DetectionBatchState | null {
    this.folder(projectId);
    const entry = this.batches.get(projectId);
    return entry ? structuredClone(entry.state) : null;
  }
  cancelBatch(projectId: string) {
    this.folder(projectId);
    const entry = this.batches.get(projectId);
    if (!entry || !entry.state.running) return;
    entry.state.stopped = true; entry.controller.abort();
  }
  async list(projectId: string): Promise<DetectionReport[]> {
    const folder = this.folder(projectId); let names: string[];
    try { names = await fs.readdir(folder); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    const reports: DetectionReport[] = [];
    for (const name of names.filter(n => /^[a-f0-9-]{36}\.json$/.test(n))) {
      const report = reportSchema.parse(JSON.parse(await fs.readFile(path.join(folder, name), 'utf8')));
      if (report.projectId !== projectId || name !== `${report.id}.json`) throw new Error('检测报告小说归属不匹配');
      reports.push(report);
    }
    return reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
  }
}
