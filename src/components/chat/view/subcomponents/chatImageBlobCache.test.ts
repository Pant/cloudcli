import assert from 'node:assert/strict';
import test from 'node:test';

import { createChatImageBlobCache } from './chatImageBlobCache';

test('visible duplicate paths share one in-flight fetch and revoke after final release', async () => {
  let resolveFetch!: (blob: Blob | null) => void;
  const fetches: string[] = [];
  const revoked: string[] = [];
  const cache = createChatImageBlobCache({
    fetchBlob: (url) => { fetches.push(url); return new Promise((resolve) => { resolveFetch = resolve; }); },
    createObjectUrl: () => 'blob:shared',
    revokeObjectUrl: (url) => revoked.push(url),
  });
  const first = cache.acquire('same', ['/thumbnail']);
  const second = cache.acquire('same', ['/thumbnail']);
  assert.deepEqual(fetches, ['/thumbnail']);
  resolveFetch(new Blob(['image']));
  assert.equal(await first.promise, 'blob:shared');
  assert.equal(await second.promise, 'blob:shared');
  first.release();
  assert.deepEqual(revoked, []);
  second.release();
  assert.deepEqual(revoked, ['blob:shared']);
  assert.equal(cache.size(), 0);
});

test('failed candidates fall back and leave no cache entry', async () => {
  const fetches: string[] = [];
  const cache = createChatImageBlobCache({
    fetchBlob: async (url) => { fetches.push(url); return null; },
    createObjectUrl: () => 'unused',
    revokeObjectUrl: () => assert.fail('nothing should be revoked'),
  });
  const acquired = cache.acquire('failure', ['/thumbnail', '/original']);
  await assert.rejects(acquired.promise, /Image unavailable/);
  assert.deepEqual(fetches, ['/thumbnail', '/original']);
  assert.equal(cache.size(), 0);
  acquired.release();
});

test('final release aborts an unfinished authenticated fetch without leaking', async () => {
  let aborted = false;
  const cache = createChatImageBlobCache({
    fetchBlob: (_url, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); });
    }),
    createObjectUrl: () => 'unused',
    revokeObjectUrl: () => assert.fail('unfinished requests have no URL'),
  });
  const acquired = cache.acquire('abort', ['/thumbnail']);
  acquired.release();
  await assert.rejects(acquired.promise, { name: 'AbortError' });
  assert.equal(aborted, true);
  assert.equal(cache.size(), 0);
});
