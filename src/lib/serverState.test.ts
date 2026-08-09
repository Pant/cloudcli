import assert from 'node:assert/strict';
import test from 'node:test';

import { KeyedServerState } from './serverState';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

test('deduplicates concurrent reads and respects staleTime', async () => {
  let calls = 0;
  let now = 10;
  const owner = new KeyedServerState(async () => ++calls, 100, () => now);
  const [a, b] = await Promise.all([owner.read('a'), owner.read('a')]);
  assert.deepEqual([a, b, calls], [1, 1, 1]);
  now = 50;
  assert.equal(await owner.read('a'), 1);
  now = 111;
  assert.equal(await owner.read('a'), 2);
});

test('force aborts prior request and fences its late resolution', async () => {
  const requests: Array<ReturnType<typeof deferred<number>>> = [];
  const signals: AbortSignal[] = [];
  const owner = new KeyedServerState((_key, signal) => {
    signals.push(signal);
    const request = deferred<number>();
    requests.push(request);
    return request.promise;
  });
  const first = owner.read('a');
  const second = owner.read('a', { force: true });
  assert.equal(signals[0].aborted, true);
  requests[1].resolve(2);
  assert.equal(await second, 2);
  requests[0].resolve(1);
  assert.equal(await first, 1);
  assert.equal(owner.getSnapshot('a').value, 2);
});

test('invalidate, patch, subscribe, and dispose update safely', async () => {
  let calls = 0;
  const owner = new KeyedServerState(async () => ++calls, 1_000);
  let notifications = 0;
  owner.subscribe('a', () => { notifications += 1; });
  await owner.read('a');
  owner.invalidate('a');
  assert.equal(owner.getSnapshot('a').invalidated, true);
  assert.equal(await owner.read('a'), 2);
  assert.equal(owner.patch('a', (value) => (value ?? 0) + 3), 5);
  assert.equal(owner.getSnapshot('a').value, 5);
  assert.ok(notifications >= 5);
  owner.dispose();
  await assert.rejects(owner.read('a'), /disposed/);
});

test('abort is not stored as a resource error', async () => {
  const owner = new KeyedServerState((_key, signal) => new Promise<number>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));
  const request = owner.read('a');
  owner.cancel('a');
  await assert.rejects(request, /Aborted/);
  assert.equal(owner.getSnapshot('a').error, null);
  assert.equal(owner.getSnapshot('a').status, 'idle');
});
