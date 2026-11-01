import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCardV2, buildCardV3, parseCard, parseCardBook, parseWorldInfoFile, selectWorldEntries, type CardFields, type StWorldEntry, type StWorldInfo } from '../src/core/st-cards';

const fields: CardFields = {
  name: '林夏', description: '雨夜的旅人', personality: '寡言', scenario: '北门客栈',
  firstMessage: '你来了。', exampleDialogue: '<START>', creatorNotes: '作者注', systemPrompt: '', postHistoryInstructions: '',
  alternateGreetings: ['雨很大。'], tags: ['奇幻'], creator: '作者', characterVersion: '1.0', extensions: { talkativeness: 0.5 }
};

test('角色卡：V2 导出满足 SillyTavern 的 14 个必填字段', () => {
  const card = buildCardV2(fields) as { spec: string; spec_version: string; data: Record<string, unknown> };
  assert.equal(card.spec, 'chara_card_v2');
  assert.equal(card.spec_version, '2.0');
  for (const key of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions', 'alternate_greetings', 'tags', 'creator', 'character_version', 'extensions'])
    assert.ok(key in card.data, `data.${key} 必须存在`);
  assert.deepEqual(card.data.alternate_greetings, ['雨很大。']);
  assert.equal((buildCardV3(fields) as { spec: string }).spec, 'chara_card_v3');
});

test('角色卡：能读回 V1/V2/V3，并把 V2 字段映射到内部结构', () => {
  const v2 = parseCard(buildCardV2(fields));
  assert.equal(v2.specVersion, 2);
  assert.equal(v2.data.firstMessage, '你来了。');
  assert.equal(v2.data.exampleDialogue, '<START>');
  const v3 = parseCard(buildCardV3(fields));
  assert.equal(v3.specVersion, 3);
  const v1 = parseCard({ name: '阿岚', description: '剑客', first_mes: '走。', mes_example: '', personality: '', scenario: '' });
  assert.equal(v1.specVersion, 1);
  assert.equal(v1.data.firstMessage, '走。');
  assert.throws(() => parseCard({ foo: 1 }), /无法识别的角色卡格式/u);
  assert.throws(() => parseCard({ spec: 'chara_card_v2', spec_version: '2.0' }), /缺少 data/u);
});

test('世界书：读 SillyTavern 的 entries 字典格式并按关键词触发', () => {
  const file = { name: '北方世界', entries: {
    '0': { key: ['北门'], content: '北门在雨夜关闭。', order: 5, constant: 0, disable: 0 },
    '1': { key: ['月钥'], keysecondary: ['林夏'], selective: 1, selectiveLogic: 0, content: '月钥只认林夏。', order: 9 },
    '2': { key: ['禁用'], content: '不该出现', disable: 1 },
    '3': { key: [], content: '常驻设定', constant: 1, order: 1 }
  } };
  const world = parseWorldInfoFile(file);
  assert.equal(world.entries.length, 4);
  assert.equal(world.entries[1].selectiveLogic, 'AND_ANY');
  const picked = selectWorldEntries(world, '林夏走到北门，握紧月钥。');
  assert.deepEqual(picked.map(entry => entry.comment || entry.content).sort(), ['北门在雨夜关闭。', '常驻设定', '月钥只认林夏。'].sort());
  assert.equal(selectWorldEntries(world, '林夏走进北门。').some(entry => entry.content.includes('月钥')), false, '次要关键词不满足时不该触发');
  assert.equal(selectWorldEntries(world, '没有关键词的一句话。').map(entry => entry.content).join(), '常驻设定');
  assert.throws(() => parseWorldInfoFile({}), /缺少 entries/u);
});

test('世界书：大小写敏感、概率与上限', () => {
  const world: StWorldInfo = {
    name: 't', extensions: {},
    entries: [
      { id: '0', keys: ['Rain'], secondaryKeys: [], content: 'A', comment: '', selective: false, selectiveLogic: 'AND_ANY', constant: false, disabled: false, order: 10, position: 'after_char', depth: null, probability: 100, caseSensitive: true },
      { id: '1', keys: ['rain'], secondaryKeys: [], content: 'B', comment: '', selective: false, selectiveLogic: 'AND_ANY', constant: false, disabled: false, order: 5, position: 'after_char', depth: null, probability: 100, caseSensitive: false }
    ]
  };
  assert.deepEqual(selectWorldEntries(world, 'heavy rain').map(entry => entry.content), ['B'], '大小写敏感条目不应命中小写文本');
  assert.deepEqual(selectWorldEntries(world, 'Heavy Rain').map(entry => entry.content), ['A', 'B']);
  assert.equal(selectWorldEntries(world, 'Heavy Rain', 1).length, 1);
});

test('世界书：标签 ID 与角色名称分别筛选，未知映射不误当作空映射', () => {
  const world = parseWorldInfoFile({ entries: {
    0: { key: ['星港'], content: '只按标签包含', characterFilter: { isExclude: false, names: [], tags: ['tag-alpha'] } },
    1: { key: ['星港'], content: '角色和标签均包含', characterFilter: { isExclude: false, names: ['林夏'], tags: ['tag-alpha'] } },
    2: { key: ['星港'], content: '排除名称和标签', characterFilter: { isExclude: true, names: ['阿岚'], tags: ['tag-block'] } }
  } });
  const content = (names: string[], tagIds?: string[]) => selectWorldEntries(world, '星港', { characterNames: names, characterTagIds: tagIds, maxRecursion: 0 }).map(item => item.content).sort();
  assert.deepEqual(content(['林夏'], ['tag-alpha']), ['只按标签包含', '排除名称和标签', '角色和标签均包含'].sort());
  assert.deepEqual(content(['林夏'], []), ['排除名称和标签']);
  assert.deepEqual(content(['阿岚'], ['tag-alpha']), ['只按标签包含']);
  assert.deepEqual(content(['林夏'], ['tag-block']), []);
  assert.deepEqual(content(['林夏']), ['只按标签包含', '排除名称和标签', '角色和标签均包含'].sort(), '没有 tagMap 时跳过标签判断，不能假称映射为空');
});

test('世界书：名称和标签必须来自同一个已确认角色', () => {
  const world = parseWorldInfoFile({ entries: { 0: { key: ['星港'], content: '不可跨角色拼接', characterFilter: { isExclude: false, names: ['alpha-avatar'], tags: ['tag-red'] } } } });
  const a = { avatarKey: 'alpha-avatar', tagIds: ['tag-blue'] }, b = { avatarKey: 'beta-avatar', tagIds: ['tag-red'] };
  assert.deepEqual(selectWorldEntries(world, '星港', { characters: [a, b], omitUnknownTagEntries: true }), []);
  assert.equal(selectWorldEntries(world, '星港', { characters: [{ ...a, tagIds: ['tag-red'] }, b], omitUnknownTagEntries: true }).length, 1);
  assert.deepEqual(selectWorldEntries(world, '星港', { characters: [{ avatarKey: 'alpha-avatar', tagIds: undefined }], omitUnknownTagEntries: true }), []);
});

test('世界书共享上下文：任一启用角色命中排除条件即不注入', () => {
  const world = parseWorldInfoFile({ entries: {
    0: { key: ['星港'], content: '排除甲', characterFilter: { isExclude: true, names: ['avatar-a'], tags: [] } },
    1: { key: ['星港'], content: '排除红标签', characterFilter: { isExclude: true, names: [], tags: ['tag-red'] } },
    2: { key: ['星港'], content: '无相关排除', characterFilter: { isExclude: true, names: ['avatar-c'], tags: ['tag-green'] } },
    3: { key: ['星港'], content: '甲与蓝标签', characterFilter: { isExclude: false, names: ['avatar-a'], tags: ['tag-blue'] } }
  } });
  const actors = [{ avatarKey: 'avatar-a', tagIds: ['tag-blue'] }, { avatarKey: 'avatar-b', tagIds: ['tag-red'] }];
  assert.deepEqual(selectWorldEntries(world, '星港', { characters: actors, omitUnknownTagEntries: true }).map(item => item.content).sort(), ['无相关排除', '甲与蓝标签'].sort());
  const unknown = [{ avatarKey: 'avatar-a', tagIds: ['tag-blue'] }, { avatarKey: 'avatar-b', tagIds: undefined }];
  assert.deepEqual(selectWorldEntries(world, '星港', { characters: unknown, omitUnknownTagEntries: true }).map(item => item.content), ['甲与蓝标签'], '标签排除的某角色映射未知时不注入 AI');
});

test('世界书：概率、递归扫描、角色过滤与 at_depth 映射', () => {
  const entry = (over: Partial<StWorldEntry> & { id: string; content: string }) => ({
    keys: [], secondaryKeys: [], comment: '', selective: false, selectiveLogic: 'AND_ANY' as const, constant: false, disabled: false,
    order: 10, position: 'after_char' as const, depth: null, probability: 100, caseSensitive: false, ...over
  });
  // 概率：random() 固定 0.5，50% 阈值取「小于」才命中
  const gated = { name: 'p', extensions: {}, entries: [entry({ id: '1', content: '低概率', keys: ['甲'], probability: 40 }), entry({ id: '2', content: '高概率', keys: ['甲'], probability: 60 })] };
  const withRandom = selectWorldEntries(gated, '甲', { random: () => 0.5 });
  assert.deepEqual(withRandom.map(item => item.content), ['高概率'], '40% 不应命中，60% 应命中');
  assert.deepEqual(selectWorldEntries(gated, '其它', { random: () => 0.5 }), [], '没命中的关键词不受概率影响');
  // 递归：第一条内容里出现「乙」，第二轮应触发第二条
  const chained = { name: 'r', extensions: {}, entries: [entry({ id: '1', content: '这里有乙的信息', keys: ['甲'] }), entry({ id: '2', content: '乙的设定', keys: ['乙'] })] };
  assert.deepEqual(selectWorldEntries(chained, '甲').map(item => item.content), ['这里有乙的信息', '乙的设定']);
  assert.deepEqual(selectWorldEntries(chained, '甲', { maxRecursion: 0 }).map(item => item.content), ['这里有乙的信息'], '关闭递归只保留第一轮');
  // 角色过滤：包含式与排除式
  const filtered = { name: 'f', extensions: {}, entries: [entry({ id: '1', content: '林夏专属', keys: ['甲'], characterFilter: { isExclude: false, names: ['林夏'], tags: [] } })] };
  assert.deepEqual(selectWorldEntries(filtered, '甲', { characterNames: ['林夏'] }).map(item => item.content), ['林夏专属']);
  assert.deepEqual(selectWorldEntries(filtered, '甲', { characterNames: ['阿岚'] }), []);
  const excluded = { name: 'f2', extensions: {}, entries: [entry({ id: '1', content: '排除林夏', keys: ['甲'], characterFilter: { isExclude: true, names: ['林夏'], tags: [] } })] };
  assert.deepEqual(selectWorldEntries(excluded, '甲', { characterNames: ['林夏'] }), []);
  assert.deepEqual(selectWorldEntries(excluded, '甲', { characterNames: ['阿岚'] }).map(item => item.content), ['排除林夏']);
  // at_depth 映射
  const world = parseWorldInfoFile({ entries: { '0': { key: ['甲'], content: 'x', position: 4, depth: 2 } } });
  assert.equal(world.entries[0].position, 'at_depth');
  assert.equal(world.entries[0].depth, 2);
});

test('世界书：四种次关键词逻辑区分无命中、部分命中、全部命中', () => {
  const cases = [
    { logic: 0, name: 'AND_ANY', expected: [false, true, true] },
    { logic: 1, name: 'NOT_ALL', expected: [true, true, false] },
    { logic: 2, name: 'NOT_ANY', expected: [true, false, false] },
    { logic: 3, name: 'AND_ALL', expected: [false, false, true] }
  ];
  const samples = ['主词', '主词 次甲', '主词 次甲 次乙'];
  for (const item of cases) {
    const world = parseWorldInfoFile({ entries: { '0': {
      key: ['主词'], keysecondary: ['次甲', '次乙'], selective: true, selectiveLogic: item.logic, content: '设定内容'
    } } });
    assert.equal(world.entries[0].selectiveLogic, item.name);
    samples.forEach((sample, index) => assert.equal(
      selectWorldEntries(world, sample, { maxRecursion: 0 }).length > 0,
      item.expected[index], `${item.name}: ${sample}`
    ));
    assert.equal(selectWorldEntries(world, '次甲 次乙', { maxRecursion: 0 }).length, 0, '次词不能绕过主词');
    world.entries[0].secondaryKeys = [];
    assert.equal(selectWorldEntries(world, '主词', { maxRecursion: 0 }).length, 1, '空次词列表按主词激活');
    world.entries[0].secondaryKeys = ['不会出现']; world.entries[0].selective = false;
    assert.equal(selectWorldEntries(world, '主词', { maxRecursion: 0 }).length, 1, '停用次词条件时按主词激活');
  }
});

test('角色卡内嵌世界书：酒馆扩展字段优先，V2/V3 导出保留选择逻辑与未知扩展', () => {
  const embedded = parseCardBook({ name: '内嵌世界', extensions: { source: 'fixture' }, entries: [{
    id: 0, keys: ['Moon'], secondary_keys: ['林夏', '北门'], content: '月钥设定', enabled: true,
    selective: true, selectiveLogic: 0, position: 'before_char', probability: 100, depth: 9, case_sensitive: false,
    extensions: { selectiveLogic: 3, position: 4, probability: 35, depth: 0, case_sensitive: true, custom_plugin: { retain: true } }
  }] });
  const entry = embedded.entries[0];
  assert.equal(entry.selectiveLogic, 'AND_ALL'); assert.equal(entry.position, 'at_depth');
  assert.equal(entry.probability, 35); assert.equal(entry.depth, 0); assert.equal(entry.caseSensitive, true);
  assert.equal(selectWorldEntries(embedded, 'Moon 林夏', { maxRecursion: 0, random: () => 0 }).length, 0);
  assert.equal(selectWorldEntries(embedded, 'moon 林夏 北门', { maxRecursion: 0, random: () => 0 }).length, 0);
  assert.equal(selectWorldEntries(embedded, 'Moon 林夏 北门', { maxRecursion: 0, random: () => 0 }).length, 1);
  assert.equal(selectWorldEntries(embedded, 'Moon 林夏 北门', { maxRecursion: 0, random: () => 0.5 }).length, 0);
  for (const build of [buildCardV2, buildCardV3]) {
    const card = build(fields, embedded);
    const exchanged = card.data.character_book!.entries[0];
    assert.equal(exchanged.position, 'after_char', '规范位置只使用 before_char/after_char，深度位置放扩展');
    const extensions = (exchanged as unknown as { extensions: Record<string, unknown> }).extensions;
    assert.ok(extensions, '酒馆读取的位置、深度和逻辑必须写入 extensions');
    assert.equal(extensions.selectiveLogic, 3); assert.equal(extensions.position, 4);
    assert.equal(extensions.depth, 0); assert.equal(extensions.probability, 35); assert.equal(extensions.case_sensitive, true);
    assert.deepEqual(extensions.custom_plugin, { retain: true });
    const roundTrip = parseCard(card).characterBook!;
    assert.equal(roundTrip.entries[0].selectiveLogic, 'AND_ALL');
    assert.equal(roundTrip.entries[0].position, 'at_depth'); assert.equal(roundTrip.entries[0].depth, 0);
    assert.equal(roundTrip.entries[0].probability, 35); assert.equal(roundTrip.entries[0].caseSensitive, true);
    assert.deepEqual(roundTrip.extensions, embedded.extensions);
  }
});

test('角色卡内嵌世界书：兼容旧版顶层逻辑并保留禁用概率开关', () => {
  const legacy = parseCardBook({ entries: [{ keys: ['甲'], content: '设定', selective: true,
    secondary_keys: ['乙', '丙'], selectiveLogic: 'NOT_ALL', probability: 0, enabled: true }] });
  assert.equal(legacy.entries[0].selectiveLogic, 'NOT_ALL');
  const noRoll = parseCardBook({ entries: [{ keys: ['甲'], content: '不掷骰', enabled: true,
    extensions: { probability: 0, useProbability: false } }] });
  assert.equal(selectWorldEntries(noRoll, '甲').length, 1, '关闭概率判断时，即便保存的概率为0也应激活');
  const roundTrip = parseCard(buildCardV2(fields, noRoll)).characterBook!;
  assert.equal(selectWorldEntries(roundTrip, '甲').length, 1);
  const zero = parseCardBook({ entries: [{ keys: ['甲'], content: '零概率', enabled: true,
    extensions: { probability: 0, useProbability: true } }] });
  assert.equal(selectWorldEntries(zero, '甲').length, 0);
});
