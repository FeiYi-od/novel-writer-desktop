import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { CharacterStore } from '../src/main/characters';
import { WorldInfoStore } from '../src/main/world-info';
import { SettingImportService } from '../src/main/setting-import';
import { ChapterOrderStore } from '../src/main/chapter-order';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import type { AIConnections } from '../src/main/ai-connections';

function sse(text: string) {
  const data = 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n';
  return Buffer.from(data, 'utf8');
}

async function server(reply: () => string) {
  const calls: { system: string; user: string }[] = [];
  const instance = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    calls.push({ system: String(body.messages?.[0]?.content ?? ''), user: String(body.messages?.[1]?.content ?? '') });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(sse(reply()));
  });
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
  const port = (instance.address() as { port: number }).port;
  return { calls, url: 'http://127.0.0.1:' + port + '/v1', close: async () => { instance.closeAllConnections(); await new Promise<void>(resolve => instance.close(() => resolve())); } };
}

async function fixture(url: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-setting-model-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials')); await workspace.initialize();
  const parent = path.join(root, 'books'); await fs.mkdir(parent);
  const project = await workspace.createProject(parent, '模型设定书');
  const characters = new CharacterStore(id => workspace.getProject(id), path.join(root, 'materials'));
  const world = new WorldInfoStore(workspace);
  const profile = { id: crypto.randomUUID(), name: '夹具', model: 'fixture-model', baseUrl: url, adapter: 'generic' as const, thinking: 'default' as const, timeoutSeconds: 30, contextWindow: 8192, maxOutputTokens: 1024, tokenParameter: 'max_tokens' as const, hasKey: false };
  const secret = { value: '' };
  const connections = { resolve: async () => ({ profile, key: secret.value }) } as unknown as AIConnections;
  const makeService = () => new SettingImportService(characters, world, connections, workspace, new ChapterOrderStore(workspace), path.join(root, 'profile'));
  const service = makeService();
  return { root, project, characters, world, service, profile, workspace, parent, secret, makeService };
}

const validReply = JSON.stringify({
  characters: [{ name: '林夏', aliases: '夏夏', appearance: '短发', personality: '嘴硬心软', background: '', goal: '找哥哥', relationship: '', speech: '短句' }],
  world: [{ title: '雾港', type: '地点', content: '终年大雾', keywords: '雾港,码头' }]
});

test('模型整理设定：返回人物与世界候选，未提供字段标出，确认后写入', async t => {
  const srv = await server(() => validReply);
  const f = await fixture(srv.url);
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const result = await f.service.modelCandidates(f.project.project.id, f.profile.id, '林夏是个嘴硬心软的姑娘，在雾港长大，想找哥哥。');
  assert.equal(result.candidates.length, 2);
  const character = result.candidates.find(item => item.kind === 'character')!;
  assert.equal(character.name, '林夏');
  assert.equal(character.fields['性格'], '嘴硬心软');
  assert.deepEqual(character.missing, ['经历', '关系']);
  assert.equal(srv.calls.length, 1);
  assert.match(srv.calls[0]!.system, /只输出 JSON/u);
  const confirmed = await f.service.confirm(f.project.project.id, result.token, result.candidates.map(item => ({ id: item.id })));
  assert.deepEqual(confirmed.characters, ['林夏']);
  assert.equal((await f.characters.read(f.project.project.id)).value.cards.length, 1);
  assert.ok(confirmed.world && confirmed.world.entries === 1);
});

test('模型整理设定：非 JSON、空候选、短文本都拒绝且不写资料', async t => {
  const bad = await server(() => '这不是 JSON');
  const f = await fixture(bad.url);
  t.after(async () => { await bad.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  await assert.rejects(f.service.modelCandidates(f.project.project.id, f.profile.id, '林夏是个嘴硬心软的姑娘，在雾港长大，想找哥哥。'), /有效 JSON/u);
  await assert.rejects(f.service.modelCandidates(f.project.project.id, f.profile.id, '太短'), /太短/u);
  await bad.close();
  const empty = await server(() => JSON.stringify({ characters: [], world: [] }));
  const g = await fixture(empty.url);
  t.after(async () => { await empty.close(); await fs.rm(g.root, { recursive: true, force: true }); });
  await assert.rejects(g.service.modelCandidates(g.project.project.id, g.profile.id, '林夏是个嘴硬心软的姑娘，在雾港长大，想找哥哥。'), /没有返回可用候选/u);
  assert.deepEqual((await g.characters.read(g.project.project.id)).value.cards, []);
});

test('模型整理长设定：按块多次调用并按名称合并候选', async t => {
  const replies = [
    JSON.stringify({ characters: [{ name: '林夏', personality: '嘴硬心软' }], world: [] }),
    JSON.stringify({ characters: [{ name: '林夏', appearance: '短发', goal: '找哥哥' }], world: [{ title: '雾港', content: '终年大雾' }] }),
    JSON.stringify({ characters: [], world: [{ title: '雾港', keywords: '雾港,码头' }] })
  ];
  let index = 0;
  const srv = await server(() => replies[Math.min(index++, replies.length - 1)]!);
  const f = await fixture(srv.url);
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const long = ('角色：林夏\n性格：嘴硬心软。\n\n' + '补充设定文字。'.repeat(400) + '\n\n').repeat(3);
  const result = await f.service.modelCandidates(f.project.project.id, f.profile.id, long, 'both', { chunkCharacters: 2000 });
  assert.ok(srv.calls.length >= 2, `长设定应分多次调用，实际 ${srv.calls.length}`);
  assert.equal((result as { chunks?: number }).chunks, srv.calls.length);
  const character = result.candidates.find(item => item.kind === 'character')!;
  assert.equal(character.fields['性格'], '嘴硬心软');
  assert.equal(character.fields['外貌'], '短发');
  assert.equal(character.fields['目标'], '找哥哥');
  const world = result.candidates.find(item => item.kind === 'world')!;
  assert.equal(world.fields['正文'], '终年大雾');
  assert.equal(world.fields['关键词'], '雾港,码头');
});

test('模型整理长设定：跨块字段冲突保留全部取值，确认时可按作者选择写入', async t => {
  const replies = [
    JSON.stringify({ characters: [{ name: '林夏', personality: '嘴硬心软' }], world: [] }),
    JSON.stringify({ characters: [{ name: '林夏', personality: '其实很怕黑' }], world: [] })
  ];
  let index = 0;
  const srv = await server(() => replies[Math.min(index++, replies.length - 1)]!);
  const f = await fixture(srv.url);
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const long = ('角色：林夏\n' + '补充说明文字。'.repeat(400) + '\n\n').repeat(2);
  const result = await f.service.modelCandidates(f.project.project.id, f.profile.id, long, 'character', { chunkCharacters: 2000 });
  const character = result.candidates[0]!;
  assert.deepEqual(character.conflicts, [{ field: '性格', values: ['嘴硬心软', '其实很怕黑'] }]);
  assert.equal(character.fields['性格'], '嘴硬心软', '默认保留先到的值，不自动裁决');
  await f.service.confirm(f.project.project.id, result.token, [{ id: character.id, fields: { 性格: '其实很怕黑' } }]);
  const saved = (await f.characters.read(f.project.project.id)).value.cards[0]!;
  assert.equal(saved.personality, '其实很怕黑', '确认时作者的选择应生效');
});

test('全文整理超过原有六万字上限：按顺序完整发送并保留作者确认及小说隔离', async t => {
  const srv = await server(() => validReply);
  const f = await fixture(srv.url);
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const id = f.project.project.id, root = f.workspace.getProject(id).root;
  const first = '开头标记。' + '甲章节内容。'.repeat(7000);
  const second = '乙章节内容。'.repeat(7000) + '结尾标记。';
  await fs.writeFile(path.join(root, '01.txt'), first, 'utf8');
  await fs.writeFile(path.join(root, '02.txt'), second, 'utf8');
  const prepared = await f.service.prepareBook(id, 6000);
  assert.equal(prepared.chapters, 2);
  assert.equal(prepared.characters, first.length + second.length);
  assert.ok(prepared.characters > 60000 && prepared.chunks > 1);
  const other = await f.workspace.createProject(f.parent, '另一小说');
  await assert.rejects(f.service.modelBookCandidates(other.project.id, prepared.token, f.profile.id, 'both'), /失效/u);
  assert.equal(srv.calls.length, 0, '预览与跨项目请求不能调用模型');
  const result = await f.service.modelBookCandidates(id, prepared.token, f.profile.id, 'both');
  assert.equal(srv.calls.length, prepared.chunks);
  const sent = srv.calls.map(call => call.user).join('');
  assert.ok(sent.includes(first) && sent.includes(second), '所有正文应完整按顺序发送');
  assert.ok(sent.indexOf(first) < sent.indexOf(second));
  assert.deepEqual((await f.characters.read(id)).value.cards, [], '候选确认前不写入');
  await assert.rejects(f.service.confirm(other.project.id, result.token, [{ id: result.candidates[0]!.id }]), /失效/u);
  await f.service.confirm(id, result.token, [{ id: result.candidates[0]!.id, fields: { 性格: '作者确认的性格' } }]);
  assert.equal((await f.characters.read(id)).value.cards[0]!.personality, '作者确认的性格');
  assert.equal(await fs.readFile(path.join(root, '01.txt'), 'utf8'), first);
  assert.equal(await fs.readFile(path.join(root, '02.txt'), 'utf8'), second);
});

test('全文整理前与确认前检查源文件变化，过期结果不能写入', async t => {
  const srv = await server(() => validReply);
  const f = await fixture(srv.url);
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const id = f.project.project.id, file = path.join(f.workspace.getProject(id).root, '正文.txt');
  await fs.writeFile(file, '第一份虚构正文用于模型提取世界观与人物。'.repeat(5));
  const stale = await f.service.prepareBook(id);
  await fs.writeFile(file, '外部更改后的虚构正文仍然应保留。'.repeat(5));
  await assert.rejects(f.service.modelBookCandidates(id, stale.token, f.profile.id, 'both'), /正文已变化/u);
  assert.equal(srv.calls.length, 0);
  const current = await f.service.prepareBook(id);
  const result = await f.service.modelBookCandidates(id, current.token, f.profile.id, 'both');
  await fs.writeFile(file, '另一次外部更改后的虚构正文。'.repeat(5));
  await assert.rejects(f.service.confirm(id, result.token, [{ id: result.candidates[0]!.id }]), /正文已变化/u);
  assert.deepEqual((await f.characters.read(id)).value.cards, []);
});

test('全文读取支持百万字和外部 DOCX，预览不调用模型，整理覆盖全部正文', async t => {
  const srv = await server(() => validReply);
  const f = await fixture(srv.url);
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const id = f.project.project.id, root = f.workspace.getProject(id).root;
  const novel = '虚构故事。'.repeat(210000);
  const docx = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun('外部 Word 章节 & 故事情节。')] })] }] }));
  await fs.writeFile(path.join(root, '01.txt'), novel);
  await fs.writeFile(path.join(root, '02.docx'), docx);
  const preview = await f.service.prepareBook(id, 20000);
  assert.equal(preview.chapters, 2);
  assert.ok(preview.characters >= novel.length + '外部 Word 章节 & 故事情节。'.length);
  assert.ok(preview.chunks > 50);
  assert.deepEqual(preview.chapterPaths, ['01.txt', '02.docx']);
  assert.equal(srv.calls.length, 0);
  await f.service.modelBookCandidates(id, preview.token, f.profile.id, 'both');
  assert.equal(srv.calls.length, preview.chunks);
  const sent = srv.calls.map(call => call.user).join('');
  assert.ok(sent.includes(novel));
  assert.ok(sent.includes('外部 Word 章节 & 故事情节。'));
  assert.deepEqual(await fs.readFile(path.join(root, '02.docx')), docx);
});

test('全文整理逐段报告进度，可中止请求，取消不能跨书且可重新开始', async t => {
  let calls = 0, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const instance = http.createServer(async (req, res) => {
    for await (const _part of req) { /* consume */ }
    calls++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (calls === 1) res.end(sse(validReply));
    else { res.flushHeaders(); entered(); }
  });
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + (instance.address() as { port: number }).port + '/v1';
  const f = await fixture(url); const retry = await server(() => validReply);
  t.after(async () => { instance.closeAllConnections(); await new Promise<void>(resolve => instance.close(() => resolve())); await retry.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const id = f.project.project.id, file = path.join(f.workspace.getProject(id).root, '正文.txt');
  await fs.writeFile(file, '虚构长篇正文。'.repeat(1800));
  const prepared = await f.service.prepareBook(id, 2000), requestId = crypto.randomUUID();
  const progress: { completed: number; total: number; phase: string }[] = [];
  const task = f.service.modelBookCandidates(id, prepared.token, f.profile.id, 'both', requestId, value => progress.push(value));
  await waiting;
  const other = await f.workspace.createProject(f.parent, '隔离书');
  assert.equal(f.service.cancelBook(other.project.id, requestId), false);
  assert.equal(f.service.cancelBook(id, requestId), true);
  await assert.rejects(task, /已取消全文整理/u);
  assert.ok(progress.some(item => item.phase === 'preparing' && item.total === prepared.chunks));
  assert.ok(progress.some(item => item.completed === 1 && item.total === prepared.chunks));
  assert.equal(calls, 2); assert.deepEqual((await f.characters.read(id)).value.cards, []);
  f.profile.baseUrl = retry.url;
  const fresh = await f.service.prepareBook(id, 2000);
  const complete: number[] = [];
  const result = await f.service.modelBookCandidates(id, fresh.token, f.profile.id, 'both', crypto.randomUUID(), value => { if (value.phase === 'processing') complete.push(value.completed); });
  assert.equal(result.chunks, fresh.chunks); assert.equal(complete.at(-1), fresh.chunks);
});

test('全文整理等待文件操作时可取消，释放后不调用模型', async t => {
  const srv = await server(() => validReply), f = await fixture(srv.url);
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const id = f.project.project.id;
  await fs.writeFile(path.join(f.workspace.getProject(id).root, '正文.txt'), '虚构长篇正文。'.repeat(300));
  const prepared = await f.service.prepareBook(id, 2000), requestId = crypto.randomUUID();
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  const task = f.service.modelBookCandidates(id, prepared.token, f.profile.id, 'both', requestId, undefined, async action => { await blocked; return action(); });
  assert.equal(f.service.cancelBook(id, requestId), true); release();
  await assert.rejects(task, /已取消全文整理/u);
  assert.equal(srv.calls.length, 0); assert.deepEqual((await f.characters.read(id)).value.cards, []);
});

test('最后一段刚完成时取消，不返回候选也不写入资料', async t => {
  const srv = await server(() => validReply), f = await fixture(srv.url);
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const id = f.project.project.id;
  await fs.writeFile(path.join(f.workspace.getProject(id).root, '正文.txt'), '虚构长篇正文。'.repeat(300));
  const prepared = await f.service.prepareBook(id, 2000), requestId = crypto.randomUUID();
  let canceled = false;
  await assert.rejects(f.service.modelBookCandidates(id, prepared.token, f.profile.id, 'both', requestId, progress => {
    if (progress.phase === 'processing' && progress.completed === progress.total) canceled = f.service.cancelBook(id, requestId);
  }), /已取消全文整理/u);
  assert.equal(canceled, true); assert.deepEqual((await f.characters.read(id)).value.cards, []);
  assert.deepEqual(await f.world.list(id), []);
  const sent = srv.calls.length;
  const result = await f.service.modelBookCandidates(id, prepared.token, f.profile.id, 'both');
  assert.equal(srv.calls.length, sent, '全部段已完成时继续只合并候选，不应重新请求');
  assert.ok(result.candidates.length > 0);
  assert.deepEqual((await f.characters.read(id)).value.cards, []);
});

test('选择章节只发送选中内容，按本书顺序读取并冻结来源', async t => {
  const srv = await server(() => validReply), f = await fixture(srv.url);
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const id = f.project.project.id, root = f.workspace.getProject(id).root;
  await fs.writeFile(path.join(root, '01.txt'), '第一章选择标记。'.repeat(20));
  await fs.writeFile(path.join(root, '02.txt'), '未选择的第二章独有标记。'.repeat(20));
  await fs.writeFile(path.join(root, '03.txt'), '第三章选择标记。'.repeat(20));
  const prepared = await f.service.prepareBook(id, 2000, ['03.txt', '01.txt']);
  assert.equal(prepared.chapters, 2); assert.equal(prepared.availableChapters, 3);
  assert.deepEqual(prepared.chapterPaths, ['01.txt', '03.txt']);
  await fs.writeFile(path.join(root, '02.txt'), '未选择章节可独立更新。'.repeat(20));
  const result = await f.service.modelBookCandidates(id, prepared.token, f.profile.id, 'both');
  const sent = srv.calls.map(call => call.user).join('');
  assert.match(sent, /第一章选择标记/u); assert.match(sent, /第三章选择标记/u);
  assert.doesNotMatch(sent, /第二章独有标记|未选择章节可独立更新/u);
  assert.ok(sent.indexOf('第一章选择标记') < sent.indexOf('第三章选择标记'));
  assert.deepEqual((await f.characters.read(id)).value.cards, []);
  await f.service.confirm(id, result.token, [{ id: result.candidates[0]!.id }]);
  assert.equal((await f.characters.read(id)).value.cards.length, 1);
});

test('选择章节拒绝空、重复、非本书路径及来源变动', async t => {
  const srv = await server(() => validReply), f = await fixture(srv.url);
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const id = f.project.project.id, root = f.workspace.getProject(id).root;
  await fs.writeFile(path.join(root, '01.txt'), '虚构第一章文字。'.repeat(20));
  await fs.writeFile(path.join(root, '02.txt'), '虚构第二章文字。'.repeat(20));
  await assert.rejects(f.service.prepareBook(id, 2000, []), /至少选择/u);
  await assert.rejects(f.service.prepareBook(id, 2000, ['01.txt', '01.txt']), /重复/u);
  await assert.rejects(f.service.prepareBook(id, 2000, ['../其他书.txt']), /不属于本书/u);
  const selected = await f.service.prepareBook(id, 2000, ['01.txt']);
  await fs.writeFile(path.join(root, '01.txt'), '所选章节已有外部变化。'.repeat(20));
  await assert.rejects(f.service.modelBookCandidates(id, selected.token, f.profile.id, 'both'), /正文已变化/u);
  assert.equal(srv.calls.length, 0);
  const current = await f.service.prepareBook(id, 2000, ['01.txt']);
  await fs.writeFile(path.join(root, '03.txt'), '新章节使目录变化。'.repeat(20));
  await assert.rejects(f.service.modelBookCandidates(id, current.token, f.profile.id, 'both'), /章节列表或顺序已变化/u);
  assert.equal(srv.calls.length, 0);
});

test('选择范围在异步读取前冻结，确认前再次检查所选正文', async t => {
  const srv = await server(() => validReply), f = await fixture(srv.url);
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const id = f.project.project.id, root = f.workspace.getProject(id).root;
  await fs.writeFile(path.join(root, '01.txt'), '第一章原始正文。'.repeat(30));
  await fs.writeFile(path.join(root, '02.txt'), '第二章原始正文。'.repeat(30));
  const selected = ['01.txt'];
  const pending = f.service.prepareBook(id, 2000, selected);
  selected[0] = '02.txt';
  const prepared = await pending;
  assert.deepEqual(prepared.chapterPaths, ['01.txt']);
  const result = await f.service.modelBookCandidates(id, prepared.token, f.profile.id, 'both');
  await fs.writeFile(path.join(root, '01.txt'), '作者在候选生成后修改的正文。'.repeat(30));
  await assert.rejects(f.service.confirm(id, result.token, [{ id: result.candidates[0]!.id }]), /正文已变化/u);
  assert.deepEqual((await f.characters.read(id)).value.cards, []);
});

test('失败分段仅在作者开启时重试一次，进度报告重试且不重复已完成分段', async t => {
  let calls = 0;
  const srv = await server(() => ++calls === 2 ? '不是 JSON' : validReply), f = await fixture(srv.url);
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const id = f.project.project.id;
  await fs.writeFile(path.join(f.workspace.getProject(id).root, '正文.txt'), '虚构故事文字。'.repeat(900));
  const prepared = await f.service.prepareBook(id, 2000); assert.ok(prepared.chunks > 1);
  const events: { completed: number; total: number; phase: string }[] = [];
  const result = await f.service.modelBookCandidates(id, prepared.token, f.profile.id, 'both', crypto.randomUUID(), value => events.push(value), undefined, true);
  assert.equal(srv.calls.length, prepared.chunks + 1);
  assert.equal(srv.calls[1]!.user, srv.calls[2]!.user, '只重试出错段');
  assert.notEqual(srv.calls[0]!.user, srv.calls[1]!.user, '已完成的前一段不能重发');
  assert.ok(events.some(value => value.phase === 'retrying' && value.completed === 1));
  assert.equal(result.chunks, prepared.chunks);
  assert.deepEqual((await f.characters.read(id)).value.cards, []);
});

test('缺失类别或格式错误的分段不能被当作空结果完成，重试仅发送失败段', async t => {
  let calls = 0;
  const srv = await server(() => ++calls === 2 ? JSON.stringify({ characters: [] }) : validReply), f = await fixture(srv.url);
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const id = f.project.project.id;
  await fs.writeFile(path.join(f.workspace.getProject(id).root, '正文.txt'), '虚构故事文字。'.repeat(900));
  const prepared = await f.service.prepareBook(id, 2000);
  await assert.rejects(f.service.modelBookCandidates(id, prepared.token, f.profile.id, 'both'), /第 2 段.*有效 JSON 设定格式/u);
  assert.equal(srv.calls.length, 2);
  assert.deepEqual((await f.characters.read(id)).value.cards, []);
  calls = 0; srv.calls.length = 0;
  const events: string[] = [];
  const result = await f.service.modelBookCandidates(id, prepared.token, f.profile.id, 'both', crypto.randomUUID(), e => events.push(e.phase), undefined, true);
  assert.equal(srv.calls.length, prepared.chunks, '已完成首段不会重发；另一段失败后重试一次');
  assert.equal(srv.calls[1]!.user, srv.calls[2]!.user);
  assert.ok(events.includes('retrying')); assert.equal(result.chunks, prepared.chunks);
  assert.deepEqual((await f.characters.read(id)).value.cards, []);
});

test('全文中断后当前读取可续跑已完成段，配置或原稿变化时不会发送请求', async t => {
  let calls = 0;
  const srv = await server(() => ++calls === 2 ? '失败' : validReply), f = await fixture(srv.url);
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const id = f.project.project.id, file = path.join(f.workspace.getProject(id).root, '正文.txt');
  const content = '虚构故事第一部分。'.repeat(600) + '虚构故事第二部分。'.repeat(600);
  await fs.writeFile(file, content);
  const prepared = await f.service.prepareBook(id, 2000); assert.ok(prepared.chunks > 1);
  await assert.rejects(f.service.modelBookCandidates(id, prepared.token, f.profile.id, 'both'), /第 2 段/u);
  assert.equal(srv.calls.length, 2);
  f.profile.model = '不同模型';
  await assert.rejects(f.service.modelBookCandidates(id, prepared.token, f.profile.id, 'both'), /模型连接、配置或整理目标已变化/u);
  f.profile.model = 'fixture-model';
  await assert.rejects(f.service.modelBookCandidates(id, prepared.token, f.profile.id, 'character'), /模型连接、配置或整理目标已变化/u);
  assert.equal(srv.calls.length, 2, '配置变化不能发起请求');
  await fs.writeFile(file, content + '正文更改');
  await assert.rejects(f.service.modelBookCandidates(id, prepared.token, f.profile.id, 'both'), /正文已变化/u);
  assert.equal(srv.calls.length, 2, '正文变化不能发起请求');
  await fs.writeFile(file, content);
  const result = await f.service.modelBookCandidates(id, prepared.token, f.profile.id, 'both');
  assert.equal(srv.calls.length, prepared.chunks + 1, '首段已完成，续跑只重发失败段和后续段');
  assert.equal(srv.calls[1]!.user, srv.calls[2]!.user);
  assert.equal(result.chunks, prepared.chunks);
  assert.deepEqual((await f.characters.read(id)).value.cards, []);
});

test('全文本机断点跨服务重建可显式恢复，核对来源与模型，未确认不写资料', async t => {
  let calls = 0;
  const srv = await server(() => ++calls === 2 ? '无效' : validReply), f = await fixture(srv.url);
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  f.secret.value = 'test-fixture-secret-only';
  const id = f.project.project.id, file = path.join(f.workspace.getProject(id).root, '正文.txt');
  const text = '原文专用虚构标记。'.repeat(1400); await fs.writeFile(file, text);
  const prepared = await f.service.prepareBook(id, 2000);
  await assert.rejects(f.service.modelBookCandidates(id, prepared.token, f.profile.id, 'both', crypto.randomUUID(), undefined, undefined, false, true), /第 2 段/u);
  const info = await f.service.readBookCheckpoint(id); assert.ok(info); assert.equal(info.completed, 1);
  const raw = await fs.readFile(path.join(f.root, 'profile', 'setting-checkpoints', `${id}.json`), 'utf8');
  assert.doesNotMatch(raw, /test-fixture-secret-only|原文专用虚构标记/u);
  const another = await f.workspace.createProject(f.parent, '另一虚构书');
  assert.equal(await f.service.readBookCheckpoint(another.project.id), null);
  const restarted = f.makeService();
  await fs.writeFile(file, text + '变化');
  await assert.rejects(restarted.restoreBookCheckpoint(id, info.hash), /来源或分段已变化/u);
  await fs.writeFile(file, text);
  const restored = await restarted.restoreBookCheckpoint(id, info.hash); assert.equal(restored.completed, 1);
  f.secret.value = 'another-fixture-secret';
  await assert.rejects(restarted.modelBookCandidates(id, restored.token, f.profile.id, 'both', crypto.randomUUID(), undefined, undefined, false, true), /模型连接、配置或整理目标已变化/u);
  assert.equal(srv.calls.length, 2);
  f.secret.value = 'test-fixture-secret-only';
  const result = await restarted.modelBookCandidates(id, restored.token, f.profile.id, 'both', crypto.randomUUID(), undefined, undefined, false, true);
  assert.equal(srv.calls.length, prepared.chunks + 1); assert.equal(result.chunks, prepared.chunks);
  assert.deepEqual((await f.characters.read(id)).value.cards, []); assert.deepEqual(await f.world.list(id), []);
  const complete = await restarted.readBookCheckpoint(id); assert.ok(complete); assert.equal(complete.completed, complete.total);
  await assert.rejects(restarted.discardBookCheckpoint(id, info.hash), /已变化/u);
  await restarted.discardBookCheckpoint(id, complete.hash); assert.equal(await restarted.readBookCheckpoint(id), null);
});

test('损坏或未知版本断点保留原文件，不允许新任务覆盖或偷偷发请求', async t => {
  const srv = await server(() => validReply), f = await fixture(srv.url);
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const id = f.project.project.id, folder = path.join(f.root, 'profile', 'setting-checkpoints');
  await fs.mkdir(folder, { recursive: true }); const file = path.join(folder, `${id}.json`);
  const raw = JSON.stringify({ schemaVersion: 99, projectId: id }); await fs.writeFile(file, raw);
  await assert.rejects(f.service.readBookCheckpoint(id), /损坏或版本不支持/u);
  await fs.writeFile(path.join(f.workspace.getProject(id).root, '正文.txt'), '用于测试保护的虚构正文。'.repeat(100));
  const prepared = await f.service.prepareBook(id, 2000);
  await assert.rejects(f.service.modelBookCandidates(id, prepared.token, f.profile.id, 'both', crypto.randomUUID(), undefined, undefined, false, true), /已有本机整理断点/u);
  assert.equal(await fs.readFile(file, 'utf8'), raw); assert.equal(srv.calls.length, 0);
});

test('异常断点明确备份并重置，校验版本和小说隔离，备份保持原字节', async t => {
  const srv = await server(() => validReply), f = await fixture(srv.url);
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const id = f.project.project.id, folder = path.join(f.root, 'profile', 'setting-checkpoints'); await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, `${id}.json`), raw = Buffer.from('{"schemaVersion":99,"未知字段":"虚构资料"}', 'utf8'); await fs.writeFile(file, raw);
  const other = await f.workspace.createProject(f.parent, '另一虚构小说');
  await assert.rejects(f.service.inspectBookCheckpointFile(other.project.id));
  const preview = await f.service.inspectBookCheckpointFile(id); assert.equal(preview.bytes, raw.length);
  await fs.writeFile(file, Buffer.from('外部修改'));
  await assert.rejects(f.service.quarantineBookCheckpoint(id, preview.hash), /已变化/u); assert.equal(await fs.readFile(file, 'utf8'), '外部修改');
  await fs.writeFile(file, raw);
  const result = await f.service.quarantineBookCheckpoint(id, preview.hash);
  assert.deepEqual(await fs.readFile(result.backup), raw); await assert.rejects(fs.lstat(file), /ENOENT/u);
  assert.equal(await f.service.readBookCheckpoint(id), null); assert.equal(srv.calls.length, 0);
  await fs.writeFile(path.join(f.workspace.getProject(id).root, '正文.txt'), '虚构设定正文。'.repeat(100));
  const prepared = await f.service.prepareBook(id, 2000);
  await f.service.modelBookCandidates(id, prepared.token, f.profile.id, 'both', crypto.randomUUID(), undefined, undefined, false, true);
  assert.ok(await f.service.readBookCheckpoint(id)); assert.deepEqual(await fs.readFile(result.backup), raw);
});

test('恢复预览后断点被外部改动时，继续前拒绝发送且保留外部内容', async t => {
  const srv = await server(() => validReply), f = await fixture(srv.url);
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const id = f.project.project.id;
  await fs.writeFile(path.join(f.workspace.getProject(id).root, '正文.txt'), '虚构正文用于断点保护。'.repeat(300));
  const prepared = await f.service.prepareBook(id, 2000), requestId = crypto.randomUUID();
  await assert.rejects(f.service.modelBookCandidates(id, prepared.token, f.profile.id, 'both', requestId, event => {
    if (event.phase === 'processing' && event.completed === 1) f.service.cancelBook(id, requestId);
  }, undefined, false, true), /已取消/u);
  const info = await f.service.readBookCheckpoint(id); assert.ok(info);
  const restarted = f.makeService(), restored = await restarted.restoreBookCheckpoint(id, info.hash);
  const file = path.join(f.root, 'profile', 'setting-checkpoints', `${id}.json`);
  const external = (await fs.readFile(file, 'utf8')) + '\n'; await fs.writeFile(file, external);
  const sent = srv.calls.length;
  await assert.rejects(restarted.modelBookCandidates(id, restored.token, f.profile.id, 'both', crypto.randomUUID(), undefined, undefined, false, true), /本机整理断点已变化/u);
  assert.equal(srv.calls.length, sent); assert.equal(await fs.readFile(file, 'utf8'), external);
});

test('模型设定按所选类别校验；空数组有效，错误条目和非文字字段不被静默丢弃', async t => {
  let reply: unknown = {};
  const srv = await server(() => JSON.stringify(reply)), f = await fixture(srv.url);
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const text = '虚构设定文本足够长用于检查模型结果结构与异常处理。';
  for (const bad of [{ characters: [], world: '无' }, { characters: [null], world: [] }, { characters: [{ name: '' }], world: [] }, { characters: [{ name: '甲', personality: { description: '复杂' } }], world: [] }, { characters: [], world: [{ content: '没有标题' }] }]) {
    reply = bad;
    await assert.rejects(f.service.modelCandidates(f.project.project.id, f.profile.id, text), /有效 JSON 设定格式/u);
  }
  reply = { characters: [{ name: '甲', personality: '冷静' }] };
  assert.equal((await f.service.modelCandidates(f.project.project.id, f.profile.id, text, 'character')).candidates.length, 1);
  reply = { world: [{ title: '港口', content: '虚构地点' }] };
  assert.equal((await f.service.modelCandidates(f.project.project.id, f.profile.id, text, 'world')).candidates.length, 1);
  reply = { characters: [{ name: '甲' }], world: [{ title: '港口' }] };
  assert.deepEqual((await f.service.modelCandidates(f.project.project.id, f.profile.id, text, 'character')).candidates.map(candidate => candidate.kind), ['character']);
  assert.deepEqual((await f.service.modelCandidates(f.project.project.id, f.profile.id, text, 'world')).candidates.map(candidate => candidate.kind), ['world']);
  reply = { characters: [{ name: '甲' }], world: '无关数据' };
  assert.equal((await f.service.modelCandidates(f.project.project.id, f.profile.id, text, 'character')).candidates.length, 1);
  reply = { characters: [], world: [] };
  await assert.rejects(f.service.modelCandidates(f.project.project.id, f.profile.id, text), /没有返回可用候选/u);
  assert.deepEqual((await f.characters.read(f.project.project.id)).value.cards, []);
});

test('默认不自动重试；选择重试后用户取消仍不发下一次请求', async t => {
  const srv = await server(() => '不是 JSON'), f = await fixture(srv.url);
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const id = f.project.project.id;
  await fs.writeFile(path.join(f.workspace.getProject(id).root, '正文.txt'), '虚构故事文字。'.repeat(300));
  const prepared = await f.service.prepareBook(id, 2000);
  await assert.rejects(f.service.modelBookCandidates(id, prepared.token, f.profile.id, 'both'), /有效 JSON/u);
  assert.equal(srv.calls.length, 1, '默认不能多发付费请求');
  const requestId = crypto.randomUUID(); let canceled = false;
  await assert.rejects(f.service.modelBookCandidates(id, prepared.token, f.profile.id, 'both', requestId, value => {
    if (value.phase === 'retrying') canceled = f.service.cancelBook(id, requestId);
  }, undefined, true), /已取消全文整理/u);
  assert.equal(canceled, true); assert.equal(srv.calls.length, 2, '取消后不发送重试请求');
  await assert.rejects(f.service.modelBookCandidates(id, prepared.token, f.profile.id, 'both', crypto.randomUUID(), undefined, undefined, true), /有效 JSON/u);
  assert.equal(srv.calls.length, 4, '开启后每段最多额外请求一次');
  assert.deepEqual((await f.characters.read(id)).value.cards, []);
});

test('认证错误不自动重试，模型截断结果不能作为完整候选', async t => {
  let calls = 0, truncated = false;
  const instance = http.createServer(async (req, res) => {
    for await (const _part of req) { /* consume */ }
    calls++;
    if (!truncated) { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: validReply }, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
  const f = await fixture('http://127.0.0.1:' + (instance.address() as {port:number}).port + '/v1');
  t.after(async () => { instance.closeAllConnections(); await new Promise<void>(resolve => instance.close(() => resolve())); await fs.rm(f.root, { recursive: true, force: true }); });
  const id = f.project.project.id; await fs.writeFile(path.join(f.workspace.getProject(id).root, '正文.txt'), '虚构故事文字。'.repeat(100));
  const prepared = await f.service.prepareBook(id, 2000);
  await assert.rejects(f.service.modelBookCandidates(id, prepared.token, f.profile.id, 'both', crypto.randomUUID(), undefined, undefined, true), /HTTP 401/u);
  assert.equal(calls, 1, '权限错误不应重试');
  truncated = true;
  await assert.rejects(f.service.modelBookCandidates(id, prepared.token, f.profile.id, 'both'), /输出被截断/u);
  assert.equal(calls, 2); assert.deepEqual((await f.characters.read(id)).value.cards, []);
});
