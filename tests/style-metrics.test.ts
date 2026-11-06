import test from 'node:test';
import assert from 'node:assert/strict';
import { measureStyleText } from '../src/core/style-metrics';

function reference(text: string) {
  const paragraphs = text.split(/\r?\n/).map(p => p.trim()).filter(Boolean);
  const compact = text.replace(/\s/g, '');
  if (!compact.length) return null;
  const sentences = compact.split(/[。！？!?]+/).filter(Boolean);
  const quotes = [...compact.matchAll(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g)].reduce((sum, match) => sum + match[0].length, 0);
  const round = (value: number) => Math.round(value * 10) / 10;
  return { characters: compact.length, paragraphs: paragraphs.length, meanSentenceLength: round(compact.length / Math.max(sentences.length, 1)), meanParagraphLength: round(compact.length / Math.max(paragraphs.length, 1)), dialogueRatio: round(quotes / compact.length * 100), firstPersonPerThousand: round((compact.match(/我/g)?.length ?? 0) / compact.length * 1000) };
}

test('流式计数与原统计语义一致，包括空白、换行、引号、标点和 Unicode', () => {
  const symbols = ['我', '甲', ' ', '\n', '\r\n', '。', '！', '?', '“', '”', '「', '」', '『', '』', '"', '😀'];
  let state = 127;
  for (let example = 0; example < 200; example++) {
    let text = '';
    for (let i = 0; i < 300; i++) { state = (state * 1664525 + 1013904223) >>> 0; text += symbols[state % symbols.length]; }
    assert.deepEqual(measureStyleText(text), reference(text));
  }
  assert.equal(measureStyleText(' \n　'), null);
});


test('海量未闭合引号不会反复扫描全文，其他引号仍能识别', () => {
  const text = '“'.repeat(300000) + '「字」';
  const start = Date.now(); const metrics = measureStyleText(text)!;
  assert.ok(Date.now() - start < 2000);
  assert.equal(metrics.dialogueRatio, 0); // 3 / 300003 rounds to 0.0%
  assert.equal(metrics.characters, text.length);
  assert.deepEqual(measureStyleText('““「内容」'), reference('““「内容」'));
});
