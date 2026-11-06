import test from 'node:test';
import assert from 'node:assert/strict';
import { readBoundedReferenceHandle, ReferenceImportBudget } from '../src/main/reference-file';

const stat = (size: number, stamp = 1) => ({ size, mtimeMs: stamp, ctimeMs: stamp, ino: 1, dev: 1, isFile: () => true });
function handle(initial: Buffer, final: Buffer, changed = false) {
  let stats = 0, maxBuffer = 0;
  return { stats: () => maxBuffer, value: {
    stat: async () => stats++ ? stat(final.length, changed ? 2 : 1) : stat(initial.length),
    read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      maxBuffer = Math.max(maxBuffer, buffer.length); const bytesRead = final.copy(buffer, offset, position, position + length); return { bytesRead, buffer };
    }
  } as any };
}
test('参考文件限长读取：稳定文件可读，超限在分配前拒绝', async () => {
  const normal = handle(Buffer.from('abcd'), Buffer.from('abcd'));
  assert.equal((await readBoundedReferenceHandle(normal.value, 4, '太大')).toString(), 'abcd'); assert.equal(normal.stats(), 5);
  const large = handle(Buffer.alloc(5), Buffer.alloc(5));
  await assert.rejects(readBoundedReferenceHandle(large.value, 4, '太大'), /太大/u); assert.equal(large.stats(), 0);
});
test('参考文件增长、缩短或同长更新时拒绝并限制读取缓存', async () => {
  for (const final of [Buffer.alloc(30), Buffer.alloc(1), Buffer.from('wxyz')]) {
    const h = handle(Buffer.from('abcd'), final, true);
    await assert.rejects(readBoundedReferenceHandle(h.value, 20, '太大'), /读取期间发生变化/u);
    assert.equal(h.stats(), 5);
  }
});


test('多文件导入在收集期间限制累计字节和字符', () => {
  const bytes = new ReferenceImportBudget(); bytes.addBytes(64 * 1024 * 1024); assert.throws(() => bytes.addBytes(1), /64 MiB/u);
  const chars = new ReferenceImportBudget(); chars.addText('甲'.repeat(4_000_000)); chars.addText('乙'.repeat(4_000_000)); assert.throws(() => chars.addText('丙'), /800 万/u);
  assert.throws(() => new ReferenceImportBudget().addText('甲'.repeat(6_000_001)), /600 万/u);
});
