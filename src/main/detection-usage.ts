import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hashText } from './ai-connections';

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.union([z.literal(''), fingerprint]);
const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const monthSchema = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/);
const identitySchema = z.object({ connectionId: z.uuid(), credentialFingerprint: fingerprint }).strict();
const attemptSchema = z.object({ requestId: z.uuid(), projectId: z.uuid().optional(), at: z.iso.datetime() }).strict();
const eventSchema = attemptSchema.extend({ status: z.enum(['success', 'error', 'unknown']),
  makersTokens: tokens.optional(), modelTokens: tokens.optional() }).strict();
const storedEventSchema = eventSchema.extend({ finalized: z.boolean() }).strict().superRefine((event, context) => {
  if (!event.finalized && (event.status !== 'unknown' || event.makersTokens !== undefined || event.modelTokens !== undefined))
    context.addIssue({ code: 'custom', message: '尚未完成请求不能携带已知用量' });
});
const calibrationSchema = z.object({ month: monthSchema, accountUsed: tokens, baselineLocalTokens: tokens, calibratedAt: z.iso.datetime() }).strict();
const schema = z.object({ schemaVersion: z.literal(1), connectionId: z.uuid(), credentialFingerprint: fingerprint,
  monthlyLimit: tokens, calibration: calibrationSchema.optional(), events: z.array(storedEventSchema).max(20000) }).strict();
const quotaSchema = z.object({ monthlyLimit: tokens, accountUsed: tokens.nullable().optional(), expectedHash: revision,
  month: monthSchema }).strict();
type Ledger = z.infer<typeof schema>;
type StoredEvent = z.infer<typeof storedEventSchema>;
export type DetectionUsageIdentity = z.infer<typeof identitySchema>;
export type DetectionUsageAttempt = z.infer<typeof attemptSchema>;
export type DetectionUsageEvent = z.infer<typeof eventSchema>;
export type DetectionUsageQuota = z.infer<typeof quotaSchema>;

const MAX_BYTES = 8 * 1024 * 1024;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const inside = (root: string, target: string) => { const relative = path.relative(root, target); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };
/** Billing periods use Beijing time even when Windows runs in another zone. */
export function detectionUsageMonth(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error('朱雀用量统计时间无效');
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 7);
}
function sum(values: Array<number | undefined>) {
  let value = 0;
  for (const next of values) { value += next ?? 0; if (!Number.isSafeInteger(value)) throw new Error('朱雀用量累计超出安全范围，记录已保留'); }
  return value;
}

/** Device-local accounting, never an official Tencent balance. A durable unknown
 * attempt is published before HTTP, then completed once; failure after billing
 * therefore remains visible rather than silently becoming zero consumption. */
export class DetectionUsageStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private directory: string, private now: () => Date = () => new Date()) {}
  private serial<T>(action: () => Promise<T>): Promise<T> { const result = this.queue.then(action); this.queue = result.catch(() => {}); return result; }
  private async location(identity: DetectionUsageIdentity, create = false) {
    const base = await fs.realpath(this.directory); let parent = base;
    for (const part of ['detection-usage', identity.connectionId]) {
      const target = path.join(parent, part);
      if (create) await fs.mkdir(target).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      try { const stat = await fs.lstat(target);
        if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(base, await fs.realpath(target))) throw new Error('朱雀用量记录目录或链接异常，原记录已保留');
      } catch (error) { if (!missing(error)) throw error; }
      parent = target;
    }
    return path.join(parent, `${identity.credentialFingerprint}.json`);
  }
  private async raw(file: string): Promise<string | null> {
    try { const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('朱雀用量记录类型、链接或大小异常，原记录已保留');
      const raw = await fs.readFile(file, 'utf8');
      if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('朱雀用量记录过大，原记录已保留');
      return raw;
    } catch (error) { if (missing(error)) return null; throw error; }
  }
  private empty(identity: DetectionUsageIdentity): Ledger { return { schemaVersion: 1, ...identity, monthlyLimit: 500000, events: [] }; }
  private async load(identity: DetectionUsageIdentity) {
    const file = await this.location(identity), raw = await this.raw(file); let value = this.empty(identity);
    if (raw !== null) {
      try { value = schema.parse(JSON.parse(raw)); }
      catch { throw new Error('朱雀用量记录损坏或版本不受支持，原记录已保留'); }
      if (value.connectionId !== identity.connectionId || value.credentialFingerprint !== identity.credentialFingerprint)
        throw new Error('朱雀用量记录与连接或凭据不匹配，原记录已保留');
      if (new Set(value.events.map(event => event.requestId)).size !== value.events.length)
        throw new Error('朱雀用量记录请求编号重复，原记录已保留');
      if (value.calibration && value.calibration.baselineLocalTokens > sum(value.events.filter(event => detectionUsageMonth(new Date(event.at)) === value.calibration!.month).map(event => event.makersTokens)))
        throw new Error('朱雀校准基准与本机用量不匹配，原记录已保留');
      sum(value.events.map(event => event.makersTokens)); sum(value.events.map(event => event.modelTokens));
    }
    return { file, raw, hash: raw === null ? '' : hashText(raw), value };
  }
  private snapshot(identity: DetectionUsageIdentity, value: Ledger, hash: string, now = this.now()) {
    const month = detectionUsageMonth(now), end = now.getTime(), start = end - 24 * 60 * 60 * 1000;
    const recent = value.events.filter(event => { const at = Date.parse(event.at); return at >= start && at <= end; });
    const monthly = value.events.filter(event => detectionUsageMonth(new Date(event.at)) === month && Date.parse(event.at) <= end);
    const localTokens = sum(monthly.map(event => event.makersTokens)), calibration = value.calibration?.month === month ? value.calibration : undefined;
    const estimatedUsed = calibration ? calibration.accountUsed + localTokens - calibration.baselineLocalTokens : localTokens;
    if (!Number.isSafeInteger(estimatedUsed) || estimatedUsed < 0) throw new Error('朱雀校准估算超出安全范围，记录已保留');
    return { ...identity, hash, month, requests24h: recent.length, errors24h: recent.filter(event => event.status === 'error').length,
      makersTokens24h: sum(recent.map(event => event.makersTokens)), modelTokens24h: sum(recent.map(event => event.modelTokens)),
      unknownUsage24h: recent.filter(event => event.makersTokens === undefined).length, localTokens, unknownUsageMonth: monthly.filter(event => event.makersTokens === undefined).length,
      monthlyLimit: value.monthlyLimit, accountUsed: calibration?.accountUsed ?? null, baselineLocalTokens: calibration?.baselineLocalTokens ?? null,
      calibratedAt: calibration?.calibratedAt ?? null, estimatedUsed, remainingEstimate: Math.max(0, value.monthlyLimit - estimatedUsed),
      usageLevel: estimatedUsed >= value.monthlyLimit ? 'exceeded' as const : estimatedUsed >= value.monthlyLimit * 0.8 ? 'near-limit' as const : 'normal' as const,
      totalEvents: value.events.length, capacity: 20000 };
  }
  async read(input: DetectionUsageIdentity) { const identity = identitySchema.parse(input), current = await this.load(identity); return this.snapshot(identity, current.value, current.hash); }
  private async backup(file: string, raw: string) {
    const folder = path.join(path.dirname(file), 'history'); await fs.mkdir(folder).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(await fs.realpath(path.dirname(file)), await fs.realpath(folder))) throw new Error('朱雀用量历史目录异常，原记录已保留');
    const target = path.join(folder, `${path.basename(file, '.json')}-${hashText(raw)}.json`), previous = await this.raw(target);
    if (previous !== null) { if (previous !== raw) throw new Error('朱雀用量历史备份异常，原记录已保留'); return; }
    await fs.writeFile(target, raw, { flag: 'wx' }).catch(async error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await this.raw(target) !== raw) throw error; });
  }
  private async publish(identity: DetectionUsageIdentity, current: Awaited<ReturnType<DetectionUsageStore['load']>>, value: Ledger) {
    schema.parse(value); const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('朱雀用量记录已达本机容量上限，请先导出归档后再检测');
    // Check arithmetic before publishing so a readable ledger never becomes an
    // unusable one merely because a remote service returned a huge integer.
    sum(value.events.map(event => event.makersTokens)); sum(value.events.map(event => event.modelTokens));
    this.snapshot(identity, value, hashText(raw));
    const file = await this.location(identity, true);
    if (current.raw !== null) await this.backup(file, current.raw);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const recheck = async () => { if (await this.location(identity) !== file || await this.raw(file) !== current.raw) throw new Error('保存期间朱雀用量记录已在外部变化，请重新读取，原记录已保留'); };
    try {
      await fs.writeFile(temporary, raw, { flag: 'wx' }); await recheck();
      if (current.raw === null) await fs.link(temporary, file);
      else { for (let attempt = 0; ; attempt++) {
        try { await fs.rename(temporary, file); break; }
        catch (error) { if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          await new Promise(resolve => setTimeout(resolve, 40 * 2 ** attempt)); await recheck(); }
      } }
    } finally { await fs.unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
    return this.snapshot(identity, value, hashText(raw));
  }
  begin(input: DetectionUsageIdentity, attemptInput: DetectionUsageAttempt) {
    const identity = identitySchema.parse(input), attempt = attemptSchema.parse(attemptInput);
    return this.serial(async () => { const current = await this.load(identity), previous = current.value.events.find(event => event.requestId === attempt.requestId);
      if (previous) { this.sameAttempt(previous, attempt); return this.snapshot(identity, current.value, current.hash); }
      if (current.value.events.length >= 20000) throw new Error('朱雀用量记录已达本机容量上限，请先导出归档后再检测');
      const value = structuredClone(current.value); value.events.push({ ...attempt, status: 'unknown', finalized: false }); return this.publish(identity, current, value);
    });
  }
  private sameAttempt(previous: DetectionUsageAttempt, event: DetectionUsageAttempt) {
    if (previous.projectId !== event.projectId || previous.at !== event.at) throw new Error('朱雀用量请求编号已被其他请求占用，原记录已保留');
  }
  record(input: DetectionUsageIdentity, eventInput: DetectionUsageEvent) {
    const identity = identitySchema.parse(input), event = eventSchema.parse(eventInput);
    return this.serial(async () => { const current = await this.load(identity), index = current.value.events.findIndex(item => item.requestId === event.requestId);
      const previous = current.value.events[index];
      if (previous) { this.sameAttempt(previous, event);
        if (previous.finalized) {
          if (previous.status !== event.status || previous.makersTokens !== event.makersTokens || previous.modelTokens !== event.modelTokens) throw new Error('朱雀用量请求已经完成，不能重复改写扣减，原记录已保留');
          return this.snapshot(identity, current.value, current.hash);
        }
      } else if (current.value.events.length >= 20000) throw new Error('朱雀用量记录已达本机容量上限，请先导出归档后再检测');
      const value = structuredClone(current.value), stored = { ...event, finalized: true };
      if (previous) value.events[index] = stored; else value.events.push(stored);
      return this.publish(identity, current, value);
    });
  }
  cancelPending(input: DetectionUsageIdentity, requestId: string) {
    const identity = identitySchema.parse(input), id = z.uuid().parse(requestId);
    return this.serial(async () => { const current = await this.load(identity), previous = current.value.events.find(event => event.requestId === id);
      if (!previous) return this.snapshot(identity, current.value, current.hash);
      if (previous.finalized) throw new Error('已完成的朱雀请求不能撤回用量记录');
      const value = structuredClone(current.value); value.events = value.events.filter(event => event.requestId !== id); return this.publish(identity, current, value);
    });
  }
  configure(input: DetectionUsageIdentity, quotaInput: DetectionUsageQuota) {
    const identity = identitySchema.parse(input), quota = quotaSchema.parse(quotaInput);
    return this.serial(async () => { const current = await this.load(identity), now = this.now(), month = detectionUsageMonth(now);
      if (quota.month !== month) throw new Error('朱雀用量月份已变化，请重新读取后校准');
      if (current.hash !== quota.expectedHash) throw new Error('朱雀用量记录已变化，请重新读取后校准');
      const value = structuredClone(current.value); value.monthlyLimit = quota.monthlyLimit;
      if (quota.accountUsed === null) delete value.calibration;
      else if (quota.accountUsed !== undefined) value.calibration = { month, accountUsed: quota.accountUsed,
        baselineLocalTokens: this.snapshot(identity, value, current.hash, now).localTokens, calibratedAt: now.toISOString() };
      return this.publish(identity, current, value);
    });
  }
}
