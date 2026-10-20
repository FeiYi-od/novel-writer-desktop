import test from 'node:test';
import assert from 'node:assert/strict';
import type { CharacterCard } from '../src/shared/contracts';
import { cardToFields, exportCardPng, placeholderPng, readExportedCard, toStFields } from '../src/main/character-export';
import { isPng, readPngText } from '../src/core/png-text';
import { parseCard, selectWorldEntries } from '../src/core/st-cards';

const card: CharacterCard = {
  id: 'c1', projectId: 'p1', enabled: true, portrait: '',
  name: '林夏', description: '雨夜的旅人', personality: '寡言', scenario: '北门客栈',
  firstMessage: '你来了。', examples: '<START>', creatorNotes: '作者注', systemPrompt: '', postHistoryInstructions: '',
  alternateGreetings: ['雨很大。'],
  source: { name: '林夏.json', format: 'st-v2-json', original: '' },
  raw: { spec: 'chara_card_v2', data: { tags: ['奇幻', '雨夜'], creator: '作者', character_version: '2.1', extensions: { talkativeness: 0.8 } } },
  warnings: []
};

test('导出：把内部角色卡写成带 chara/ccv3 的 PNG，字段与标签都保留', () => {
  const png = exportCardPng(card);
  assert.equal(isPng(png), true);
  const text = readPngText(png);
  assert.ok(text.has('chara') && text.has('ccv3'));
  const parsed = readExportedCard(png);
  assert.equal(parsed.specVersion, 3);
  assert.equal(parsed.data.name, '林夏');
  assert.equal(parsed.data.firstMessage, '你来了。');
  assert.deepEqual(parsed.data.tags, ['奇幻', '雨夜']);
  assert.equal(parsed.data.creator, '作者');
  assert.equal(parsed.data.characterVersion, '2.1');
  assert.deepEqual(parsed.data.extensions, { talkativeness: 0.8 }, '原始扩展字段要带过去');
});

test('导出：没有立绘时用 1×1 占位图，仍是合法 PNG', () => {
  const png = placeholderPng();
  assert.equal(isPng(png), true);
  assert.ok(png.length > 8);
});

test('导入：读回 V2/V3 卡片并映射成内部字段，内嵌角色书被识别', () => {
  const png = exportCardPng(card);
  const parsed = cardToFields(readExportedCard(png));
  assert.equal(parsed.specVersion, 3);
  assert.equal(parsed.fields.examples, '<START>');
  assert.deepEqual(parsed.fields.alternateGreetings, ['雨很大。']);
  assert.equal(parsed.characterBook, null);
  assert.equal(toStFields(card).exampleDialogue, '<START>');
});

test('PNG 实际导出入口：V2/V3 内嵌世界书进入两个数据块，扩展与原件保持不变', () => {
  for (const version of [2, 3]) {
    const original: CharacterCard = { ...card, raw: {
      spec: `chara_card_v${version}`, spec_version: `${version}.0`, data: {
        name: '旧名字', description: '旧描述', extensions: { custom_card: { keep: true } },
        character_book: { name: '月钥世界', extensions: { custom_book: { keep: true } }, entries: [{
          id: 0, keys: ['月钥'], secondary_keys: ['林夏', '北门'], content: '月钥只在北门生效。',
          enabled: true, selective: true, insertion_order: 7, position: 'after_char',
          extensions: { selectiveLogic: 3, depth: 2, position: 4, probability: 60, useProbability: false,
            case_sensitive: true, custom_entry: { keep: true } }
        }] }
      }
    } };
    const before = structuredClone(original);
    const chunks = readPngText(exportCardPng(original));
    for (const [chunk, expectedVersion] of [['chara', 2], ['ccv3', 3]] as const) {
      const raw = JSON.parse(Buffer.from(chunks.get(chunk)!, 'base64').toString('utf8'));
      const parsed = parseCard(raw);
      assert.equal(parsed.specVersion, expectedVersion);
      assert.equal(parsed.data.name, card.name, '角色编辑字段仍优先于原卡旧值');
      assert.deepEqual(parsed.data.extensions, { custom_card: { keep: true } });
      assert.ok(parsed.characterBook, `${chunk} 不得丢失内嵌世界书`);
      assert.equal(parsed.characterBook.entries.length, 1);
      assert.deepEqual(parsed.characterBook.extensions, { custom_book: { keep: true } });
      assert.deepEqual(raw.data.character_book.entries[0].extensions.custom_entry, { keep: true });
      const entry = parsed.characterBook.entries[0];
      assert.equal(entry.selectiveLogic, 'AND_ALL'); assert.equal(entry.position, 'at_depth'); assert.equal(entry.depth, 2);
      assert.equal(entry.probability, 60); assert.equal(entry.caseSensitive, true);
      assert.equal(selectWorldEntries(parsed.characterBook, '月钥 林夏 北门', { random: () => 0.9 }).length, 1,
        '导出后仍保留关闭概率判断的语义');
      assert.equal(selectWorldEntries(parsed.characterBook, '月钥 林夏', { random: () => 0 }).length, 0);
    }
    assert.deepEqual(original, before, 'PNG 导出不得修改已保存的角色原件与未知扩展');
  }
});
