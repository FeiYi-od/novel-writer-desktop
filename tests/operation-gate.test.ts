import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationGate } from '../src/main/operation-gate';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
test('directory swap waits for existing reads; later reads cannot observe the intermediate directory', async () => {
  const gate = new OperationGate(), first = deferred(), swap = deferred(), calls: string[] = [];
  const read = gate.shared(async () => { calls.push('read'); await first.promise; calls.push('read-done'); });
  const write = gate.exclusive(async () => { calls.push('swap'); await swap.promise; calls.push('swap-done'); });
  const after = gate.shared(() => { calls.push('after'); });
  assert.equal(gate.exclusivePending, true);
  await Promise.resolve(); assert.deepEqual(calls, ['read']);
  first.resolve(); await read;
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, ['read', 'read-done', 'swap']);
  swap.resolve(); await Promise.all([write, after]);
  assert.deepEqual(calls, ['read', 'read-done', 'swap', 'swap-done', 'after']);
  assert.equal(gate.exclusivePending, false);
});
test('ordinary reads run together; errors release exclusivity and writers retain arrival order', async () => {
  const gate = new OperationGate(), first = deferred(), calls: string[] = [];
  const one = gate.shared(async () => { calls.push('one'); await first.promise; });
  const two = gate.shared(() => { calls.push('two'); });
  const failure = gate.exclusive(() => { calls.push('fail'); throw new Error('preserved'); });
  const assertion = assert.rejects(failure, /preserved/);
  const last = gate.exclusive(() => { calls.push('last'); });
  await two; assert.deepEqual(calls, ['one', 'two']);
  first.resolve(); await Promise.all([one, assertion, last]);
  await gate.shared(() => calls.push('ready'));
  assert.deepEqual(calls, ['one', 'two', 'fail', 'last', 'ready']);
});
