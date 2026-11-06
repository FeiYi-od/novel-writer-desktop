import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFullText, splitForAnalysis } from '../src/core/style-fulltext';
import { analyzeText } from '../src/core/style-analysis';

// 合成三个区段：开头短句多对白、中段长句多叙述、尾段中等长度；用来验证"真的覆盖到了结尾"。
const opening = Array.from({ length: 400 }, (_, index) => `“短句对白第${index}句。”他说。`).join('\n');
const middle = Array.from({ length: 200 }, (_, index) => `这是一段用来制造长句的叙述，包含多个从句、补充说明和细节描写，用来拉长平均句长并压低对白比例，第${index}段继续铺陈场景与人物心理活动。`).join('\n');
const ending = Array.from({ length: 300 }, (_, index) => `结尾段落第${index}句，长度适中，偶尔出现“一句对白”来保持节奏。`).join('\n');
const book = `${opening}\n${middle}\n${ending}`;

test('全文分段：切块覆盖整本，块数符合预算且不丢字符', () => {
  const chunks = splitForAnalysis(book, 4000);
  assert.ok(chunks.length > 3, `应切成多块，实际 ${chunks.length}`);
  assert.equal(chunks.join(''), book.replace(/\r\n?/gu, '\n'), '拼回去必须与原文一致');
});

test('全文分段：指标覆盖整篇，覆盖记录包含总字符与块数', () => {
  const { metrics, coverage } = analyzeFullText(book, { chunkCharacters: 4000 });
  assert.equal(coverage.mode, 'full');
  assert.ok(coverage.characters >= metrics.characters, '覆盖字符应不小于统计字符');
  assert.equal(coverage.chunks, splitForAnalysis(book, 4000).length);
  assert.ok(metrics.dialogueRatio > 10, '全文对白比例不应被开头显著拉高到异常');
  assert.ok(coverage.dialogueRatio.max > coverage.dialogueRatio.min, '不同区段的对白比例应有差异');
  assert.ok(coverage.sentenceLength.max > coverage.sentenceLength.min, '不同区段的句子长度应有差异');
});

test('全文分段：十万字级文本可在合理时间内完成，且覆盖到结尾标记', () => {
  const big = `${book.repeat(12)}\n${'尾部标记：最后一段必须被统计到。'.repeat(2000)}`;
  const started = Date.now();
  const { metrics, coverage } = analyzeFullText(big, { chunkCharacters: 20000 });
  const bigChunks = splitForAnalysis(big, 20000);
  assert.ok(Date.now() - started < 5000, '十万字级分析应在 5 秒内完成');
  assert.ok(metrics.characters > 100000, `应统计超过十万字，实际 ${metrics.characters}`);
  assert.equal(coverage.chunks, bigChunks.length);
  assert.ok(big.replace(/\s/g, '').length >= metrics.characters);
});

test('全文分段：空白文本拒绝，短文本仍可分析', () => {
  assert.throws(() => analyzeFullText('   \n\n  '), /至少需要 100 个非空白字符/u);
  const short = analyzeFullText('第一句。第二句。'.repeat(20));
  assert.equal(short.coverage.mode, 'full');
  assert.equal(short.coverage.chunks, 1);
});

test('全文分段：有章节标题时优先按章切分，且不丢字符', () => {
  const chapter = (n: number) => '第' + n + '章 标题' + n + '\n' + '　　正文内容。'.repeat(200) + '\n';
  const book = Array.from({ length: 6 }, (_, index) => chapter(index + 1)).join('');
  const chunks = splitForAnalysis(book, 3000);
  assert.ok(chunks.length >= 2, '应切成多块');
  assert.equal(chunks.join(''), book, '拼回去必须与原文一致');
  for (const chunk of chunks.slice(0, -1)) {
    const firstLine = chunk.split('\n').find(line => line.trim())!;
    assert.match(firstLine, /^第\d+章/u, `每块应以章节标题开头，实际：${firstLine}`);
  }
});

test('全文分段：章节标题过少时退回段落/硬切，仍然完整覆盖', () => {
  const text = '第1章 唯一标题\n' + '　　很长的正文。'.repeat(900);
  const chunks = splitForAnalysis(text, 2500);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.length >= 2);
});

test('全文统计不漏少于 20 字的尾段，也不把硬切算成新段落或新句子', () => {
  const text = '甲'.repeat(2000) + '尾';
  const result = analyzeFullText(text, { chunkCharacters: 2000 });
  assert.equal(result.coverage.chunks, 2);
  assert.equal(result.metrics.characters, 2001);
  assert.equal(result.coverage.characters, 2001);
  assert.deepEqual(result.metrics, analyzeText(text).metrics);
  assert.equal(result.metrics.paragraphs, 1);
});


test('百万字与密集标题的全文分段可完成且覆盖全文', () => {
  const text = '序章\n正文一句。\n'.repeat(110000);
  const started = Date.now();
  const chunks = splitForAnalysis(text, 2000);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.length > 400);
  assert.ok(Date.now() - started < 5000, '密集标题切块应避免平方级扫描');
  const { coverage } = analyzeFullText(text, { chunkCharacters: 20000 });
  assert.equal(coverage.characters, text.replace(/\s/g, '').length);
});
