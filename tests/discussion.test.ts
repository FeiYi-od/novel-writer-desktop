import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildSummaryPrompt, discussionRequestTokens, estimateTokens, normalizeSummary, planCompression, usedTokens, type DiscussionMessage } from '../src/core/discussion';
import { DiscussionStore } from '../src/main/discussion';
import { Workspace } from '../src/main/workspace';

const message = (id: string, role: DiscussionMessage['role'], content: string, extra: Partial<DiscussionMessage> = {}): DiscussionMessage =>
  ({ id, role, content, at: '2026-10-18T00:00:00Z', ...extra });

test('压缩计划：接近上下文上限才触发，并保留最近几条', () => {
  const many = Array.from({ length: 20 }, (_, index) => message(`m${index}`, index % 2 ? 'assistant' : 'user', '这是一段讨论内容，用来把长度堆起来。'.repeat(6)));
  const small = planCompression(many, 200_000);
  assert.equal(small.needed, false, '上下文很大时不应压缩');
  const tight = planCompression(many, 2000, { reserveTokens: 500, keepRecent: 4 });
  assert.equal(tight.needed, true);
  assert.ok(tight.compressIds.length > 0 && tight.compressIds.length <= many.length - 4, '首个压缩请求本身也必须在预算内');
  assert.deepEqual(tight.keepIds.slice(-4), many.slice(-4).map(item => item.id));
  assert.ok(discussionRequestTokens(tight.summaryPrompt) + 500 <= 2000);
  assert.equal(tight.summaryPrompt[0]!.role, 'system');
  assert.match(tight.summaryPrompt[0]!.content, /不得补充推测/u);
  assert.ok(usedTokens(many) > tight.budget);
});

test('压缩计划：已压缩的消息不再计入占用，消息太少也不压', () => {
  const compressed = message('old', 'user', '很长的旧消息'.repeat(50), { compressedInto: 'sum1' });
  const fresh = [message('a', 'user', '短消息'), message('b', 'assistant', '短回复')];
  const plan = planCompression([compressed, ...fresh], 2000, { reserveTokens: 500, keepRecent: 6 });
  assert.equal(plan.needed, false, '去重后消息不足 keepRecent 时不压缩');
  assert.equal(usedTokens([compressed, ...fresh]), usedTokens(fresh), '已压缩内容不重复占用预算');
});

test('压缩结果：空摘要和超长摘要均拒绝，不能截掉未知决定；预算对中文更保守', () => {
  assert.throws(() => normalizeSummary('   '), /压缩结果为空/u);
  assert.equal(normalizeSummary('要点一\n要点二'), '要点一\n要点二');
  assert.throws(() => normalizeSummary('字'.repeat(5000)), /摘要过长/u);
  assert.ok(estimateTokens('中文中文中文') > estimateTokens('abcdef'));
});

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-discussion-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials'));
  await workspace.initialize();
  const book = path.join(root, '甲'); await fs.mkdir(book);
  const project = await workspace.attach(book);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { workspace, project, store: new DiscussionStore(workspace) };
}

test('讨论记录：追加消息、压缩后原文仍可展开、并发写入被拒绝', async t => {
  const f = await fixture(t);
  let snapshot = await f.store.read(f.project.id);
  assert.deepEqual(snapshot.messages, []);
  snapshot = await f.store.append(f.project.id, { role: 'user', content: '第一问' }, snapshot.hash);
  snapshot = await f.store.append(f.project.id, { role: 'assistant', content: '第一答' }, snapshot.hash);
  assert.deepEqual(snapshot.messages.map(item => item.content), ['第一问', '第一答']);
  const ids = snapshot.messages.map(item => item.id);
  const compressed = await f.store.compress(f.project.id, { ids, summary: '要点：讨论了开篇走向。' }, snapshot.hash);
  assert.equal(compressed.messages.length, 3, '压缩后应多出一条摘要');
  const summary = compressed.messages.find(item => item.role === 'system')!;
  assert.equal(summary.content, '要点：讨论了开篇走向。');
  assert.deepEqual(compressed.messages.filter(item => item.compressedInto === summary.id).map(item => item.content), ['第一问', '第一答']);
  assert.deepEqual((await f.store.expand(f.project.id, summary.id)).map(item => item.content), ['第一问', '第一答'], '原文必须可展开');
  await assert.rejects(f.store.append(f.project.id, { role: 'user', content: '过期写入' }, snapshot.hash), /已在外部变化/u);
  await assert.rejects(f.store.compress(f.project.id, { ids: [], summary: 'x' }, compressed.hash), /没有可压缩的消息/u);
});

test('讨论压缩：现有摘要与新问题及系统提示均计入计划，不把旧摘要当免费上下文', () => {
  const messages = [message('summary', 'system', '世界设定：'.repeat(200)), ...Array.from({ length: 8 }, (_, index) => message(`m${index}`, 'user', '短问答'))];
  const base = planCompression(messages, 4096, { reserveTokens: 512 });
  assert.ok(base.usedTokens >= estimateTokens(messages[0].content));
  const incoming = planCompression(messages, 4096, { reserveTokens: 512, newText: '新问题'.repeat(100), system: '系统规则'.repeat(100) });
  assert.ok(incoming.usedTokens > base.usedTokens);
  assert.ok(base.compressIds.includes('summary'), '旧摘要也须可进入后续完整压缩');
});

test('讨论压缩：摘要提示词保留全部被标记文本，不从 24000 字符静默截掉后半段', () => {
  const prefix = '早期讨论'.repeat(6500), tail = '末尾不可丢失的未决事项';
  const prompt = buildSummaryPrompt([message('a', 'user', prefix), message('b', 'assistant', tail)]);
  assert.ok(prompt[1].content.includes(tail)); assert.ok(prompt[1].content.includes(prefix));
});

async function crowded(f: Awaited<ReturnType<typeof fixture>>) {
  let snapshot = await f.store.read(f.project.id);
  for (let index = 0; index < 10; index++) snapshot = await f.store.append(f.project.id, { role: index % 2 ? 'assistant' : 'user', content: `第${index}条：${'讨论'.repeat(110)}` }, snapshot.hash);
  return snapshot;
}

for (const mode of ['empty', 'length', 'oversized'] as const) test(`讨论压缩：${mode} 摘要失败不标记原文、不发送后续回答`, async t => {
  const f = await fixture(t), before = await crowded(f); let calls = 0;
  await assert.rejects(f.store.ask(f.project.id, { text: '继续讨论', contextWindow: 4096, maxOutputTokens: 512,
    stream: async (_messages, onText) => { calls++; if (mode === 'length') onText('部分摘要'); if (mode === 'oversized') onText('字'.repeat(2000)); return mode === 'length' ? 'length' : 'stop'; } }), /摘要|压缩/u);
  const after = await f.store.read(f.project.id);
  assert.equal(after.hash, before.hash); assert.equal(calls, 1); assert.ok(after.messages.every(item => !item.compressedInto));
});

test('讨论预算：仅新问题与输出预留已超窗口时不调用模型、不改原讨论', async t => {
  const f = await fixture(t), before = await f.store.read(f.project.id); let calls = 0;
  await assert.rejects(f.store.ask(f.project.id, { text: '新'.repeat(5000), system: '规则', contextWindow: 4096, maxOutputTokens: 512,
    stream: async () => { calls++; return 'stop'; } }), /预算|上下文/u);
  assert.equal(calls, 0); assert.equal((await f.store.read(f.project.id)).hash, before.hash);
});

test('讨论记录：未知版本拒绝追加并保留原字节', async t => {
  const f = await fixture(t), file = path.join(f.project.root, '小说资料', '讨论记录.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const raw = JSON.stringify({ schemaVersion: 99, messages: [], future: 'keep' }); await fs.writeFile(file, raw);
  await assert.rejects(f.store.append(f.project.id, { role: 'user', content: '新内容' }, createHash('sha256').update(raw).digest('hex')));
  assert.equal(await fs.readFile(file, 'utf8'), raw);
});

test('讨论压缩：分批摘要均在真实输入预算内、旧摘要进入后续压缩，原文可逐层展开', async t => {
  const f = await fixture(t), before = await crowded(f);
  const calls: { role: string; content: string }[][] = []; let summaries = 0;
  const result = await f.store.ask(f.project.id, { text: '之后怎么写？', contextWindow: 4096, maxOutputTokens: 512, system: '只讨论，不写入正史。',
    stream: async (messages, onText) => {
      calls.push(structuredClone(messages));
      assert.ok(discussionRequestTokens(messages) + 512 <= 4096, '压缩请求和最终回答都不能越过窗口');
      if (messages[0]?.content.includes('对话压缩器')) { summaries++; onText(`第${summaries}份摘要：只保留已讨论的决定和未决事项。`); }
      else onText('新的讨论回答。');
      return 'stop';
    } });
  assert.ok(summaries >= 2, '长历史应分为完整且有界的摘要请求');
  assert.equal(calls.length, summaries + 1);
  assert.ok(calls.slice(1, -1).some(messages => messages.some(message => message.content.includes('第1份摘要'))), '先前摘要必须传给下一次摘要模型');
  for (const original of before.messages) {
    assert.equal(result.snapshot.messages.find(item => item.id === original.id)?.content, original.content);
    const target = result.snapshot.messages.find(item => item.id === original.id)?.compressedInto;
    if (target) assert.ok((await f.store.expand(f.project.id, target)).some(item => item.id === original.id));
  }
  assert.equal(result.snapshot.messages.at(-2)?.content, '之后怎么写？');
  assert.equal(result.snapshot.messages.at(-1)?.content, '新的讨论回答。');
});

test('讨论压缩：单条旧消息也不能截断塞入过小窗口，发送前拒绝并保留原记录', async t => {
  const f = await fixture(t), initial = await f.store.read(f.project.id);
  const before = await f.store.append(f.project.id, { role: 'user', content: '完整旧文'.repeat(4000) }, initial.hash);
  let calls = 0;
  await assert.rejects(f.store.ask(f.project.id, { text: '继续', contextWindow: 4096, maxOutputTokens: 512,
    stream: async () => { calls++; return 'stop'; } }), /上下文预算/u);
  assert.equal(calls, 0); assert.equal((await f.store.read(f.project.id)).hash, before.hash);
});

test('讨论压缩：压缩期间原记录被外部修改则停止后续收费请求，不覆盖外部版本', async t => {
  const f = await fixture(t), before = await crowded(f), file = path.join(f.project.root, '小说资料', '讨论记录.json');
  let calls = 0, external = '';
  await assert.rejects(f.store.ask(f.project.id, { text: '继续', contextWindow: 4096, maxOutputTokens: 512,
    stream: async (_messages, onText) => {
      calls++; onText('完整的短摘要。');
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));
      raw.messages.at(-1).content = '另一台设备修改的讨论。'; external = JSON.stringify(raw); await fs.writeFile(file, external);
      return 'stop';
    } }), /外部变化/u);
  assert.equal(calls, 1); assert.equal(await fs.readFile(file, 'utf8'), external);
  const after = await f.store.read(f.project.id);
  assert.equal(after.messages.length, before.messages.length); assert.ok(after.messages.every(item => !item.compressedInto));
});
