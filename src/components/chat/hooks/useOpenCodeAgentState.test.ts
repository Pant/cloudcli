import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentPreferenceKey,
  hydrateAgentPreferences,
  normalizeAgentPreference,
  resolveAgentPreference,
} from './useOpenCodeAgentState';

test('keeps preferences isolated by workspace and agent', () => {
  const cache = hydrateAgentPreferences({}, '/workspace', [
    { name: 'Architect', model: 'provider/architect', reasoningEffort: 'high' },
    { name: 'Code', model: 'provider/code', reasoningEffort: 'low' },
  ]);
  assert.deepEqual(resolveAgentPreference(cache, '/workspace', 'Architect'), {
    model: 'provider/architect', reasoningEffort: 'high',
  });
  assert.deepEqual(resolveAgentPreference(cache, '/workspace', 'Code'), {
    model: 'provider/code', reasoningEffort: 'low',
  });
  assert.equal(cache[agentPreferenceKey('/other', 'Architect')], undefined);
});

test('runtime hydration authoritatively seeds model and reasoning', () => {
  const key = agentPreferenceKey(undefined, 'Code');
  const cache = hydrateAgentPreferences({
    [key]: { model: 'old/model', reasoningEffort: 'low' },
  }, undefined, [{ name: 'Code', model: 'runtime/model', reasoningEffort: 'xhigh' }]);
  assert.deepEqual(cache[key], { model: 'runtime/model', reasoningEffort: 'xhigh' });
});

test('normalizes absent reasoning to the frontend default sentinel', () => {
  assert.deepEqual(normalizeAgentPreference({ model: '  provider/model  ' }), {
    model: 'provider/model', reasoningEffort: 'default',
  });
  assert.deepEqual(normalizeAgentPreference({ reasoningEffort: '   ' }), {
    reasoningEffort: 'default',
  });
});

test('restores the selected agent pair without carrying another agent reasoning', () => {
  const cache = hydrateAgentPreferences({}, '/workspace', [
    { name: 'Architect', model: 'a/model', reasoningEffort: 'high' },
    { name: 'Code', model: 'c/model' },
  ]);
  assert.deepEqual(resolveAgentPreference(cache, '/workspace', 'Code'), {
    model: 'c/model', reasoningEffort: 'default',
  });
});
