import assert from 'node:assert/strict';
import test from 'node:test';

import { persistOpenCodePreferenceChange } from './agentPreferenceIntegration';

test('persists an agent model before session and queued next-turn updates', async () => {
  const events: string[] = [];
  const queued: Array<Record<string, string | undefined>> = [];
  const result = await persistOpenCodePreferenceChange({
    agent: 'Architect',
    patch: { model: 'anthropic/claude-opus-4-1' },
    updateAgentPreferences: async () => {
      events.push('agent');
      return { model: 'anthropic/claude-opus-4-1', reasoningEffort: 'high' };
    },
    persistSessionModel: async () => { events.push('session'); },
    patchQueuedOptions: (patch) => { events.push('queue'); queued.push(patch); },
    isCurrent: () => true,
  });
  assert.deepEqual(events, ['agent', 'session', 'queue']);
  assert.deepEqual(queued[0], { agent: 'Architect', model: 'anthropic/claude-opus-4-1' });
  assert.equal(result?.model, 'anthropic/claude-opus-4-1');
});

test('reasoning updates only the selected agent queued option after success', async () => {
  let persisted = false;
  let queued: Record<string, string | undefined> | null = null;
  await persistOpenCodePreferenceChange({
    agent: 'Code',
    patch: { reasoningEffort: 'low' },
    updateAgentPreferences: async () => {
      persisted = true;
      return { model: 'openai/gpt-5', reasoningEffort: 'low' };
    },
    patchQueuedOptions: (patch) => {
      assert.equal(persisted, true);
      queued = patch;
    },
    isCurrent: () => true,
  });
  assert.deepEqual(queued, { agent: 'Code', effort: 'low' });
});

test('failed and stale preference operations do not patch queues or report success', async () => {
  let queueCount = 0;
  await assert.rejects(() => persistOpenCodePreferenceChange({
    agent: 'Architect',
    patch: { model: 'broken' },
    updateAgentPreferences: async () => { throw new Error('failed'); },
    patchQueuedOptions: () => { queueCount += 1; },
    isCurrent: () => true,
  }));
  const stale = await persistOpenCodePreferenceChange({
    agent: 'Architect',
    patch: { reasoningEffort: 'high' },
    updateAgentPreferences: async () => ({ reasoningEffort: 'high' }),
    patchQueuedOptions: () => { queueCount += 1; },
    isCurrent: () => false,
  });
  assert.equal(stale, null);
  assert.equal(queueCount, 0);
});
