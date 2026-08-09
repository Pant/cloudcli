import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const workerSource = await readFile(new URL('../../public/sw.js', import.meta.url), 'utf8');

const runPush = async (payload, rejectRichOptions = false) => {
  const listeners = new Map();
  const calls = [];
  const self = {
    addEventListener: (name, listener) => listeners.set(name, listener),
    registration: {
      showNotification: async (title, options) => {
        calls.push({ title, options });
        if (rejectRichOptions && calls.length === 1 && ('vibrate' in options || 'actions' in options)) {
          throw new Error('unsupported options');
        }
      },
    },
    clients: { claim: () => {}, matchAll: async () => [], openWindow: async () => {} },
    skipWaiting: () => {},
    location: { origin: 'https://cloudcli.test' },
  };
  vm.runInNewContext(workerSource, {
    self,
    caches: { open: async () => ({ addAll: async () => {} }), keys: async () => [], match: async () => null },
    fetch: async () => {},
    Response,
  });
  let pending;
  listeners.get('push')({
    data: { json: () => payload },
    waitUntil: (promise) => { pending = promise; },
  });
  await pending;
  return calls;
};

test('primary and subtask OpenCode completions request completion vibration', async () => {
  const primary = await runPush({ data: { provider: 'opencode', code: 'run.stopped', stopReason: 'completed', replyEligible: true } });
  const subtask = await runPush({ data: { provider: 'opencode', code: 'task.completed' } });
  assert.deepEqual(Array.from(primary[0].options.vibrate), [200, 100, 200]);
  assert.deepEqual(Array.from(subtask[0].options.vibrate), [200, 100, 200]);
});

test('non-completion notifications do not request vibration', async () => {
  const calls = await runPush({ data: { provider: 'opencode', code: 'run.failed' } });
  assert.equal('vibrate' in calls[0].options, false);
});

test('unsupported rich options fall back to a displayed notification', async () => {
  const calls = await runPush({ data: { provider: 'opencode', code: 'task.completed' } }, true);
  assert.equal(calls.length, 2);
  assert.equal('vibrate' in calls[1].options, false);
  assert.equal('actions' in calls[1].options, false);
});
