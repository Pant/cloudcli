import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderSkill } from '../types';

import {
  mutateOpenCodeSkillAccess,
  normalizeSkill,
} from './useProviderSkills';

const skill = (sourcePath: string, enabled: boolean): ProviderSkill => ({
  provider: 'opencode',
  name: 'shared-name',
  description: 'Description',
  command: 'shared-name',
  scope: 'user',
  sourcePath,
  enabled,
});

test('normalizes explicit disabled state and defaults missing enabled to true', () => {
  assert.equal(normalizeSkill('opencode', { name: 'disabled', enabled: false }).enabled, false);
  assert.equal(normalizeSkill('opencode', { name: 'legacy' }).enabled, true);
});

test('successful project toggle sends scoped PATCH data, updates duplicates, invalidates, and refetches', async () => {
  const calls: string[] = [];
  const payloads: unknown[] = [];
  const current = [skill('/one/SKILL.md', true), skill('/two/SKILL.md', true), { ...skill('/other/SKILL.md', true), name: 'other' }];

  const updated = await mutateOpenCodeSkillAccess({
    skill: current[0],
    enabled: false,
    project: { projectId: 'project', displayName: 'Project', path: '/workspace/project' },
    skills: current,
    updateAccess: async (provider, payload) => {
      calls.push(`patch:${provider}`);
      payloads.push(payload);
      return { provider, name: payload.name, enabled: payload.enabled, access: 'deny', scope: payload.scope };
    },
    invalidateCache: (provider) => calls.push(`invalidate:${provider}`),
    refetch: async () => { calls.push('refetch'); return []; },
  });

  assert.deepEqual(payloads, [{ name: 'shared-name', enabled: false, scope: 'project', workspacePath: '/workspace/project' }]);
  assert.deepEqual(calls, ['patch:opencode', 'invalidate:opencode', 'refetch']);
  assert.deepEqual(updated.map(({ name, enabled }) => ({ name, enabled })), [
    { name: 'shared-name', enabled: false },
    { name: 'shared-name', enabled: false },
    { name: 'other', enabled: true },
  ]);
});

test('failed toggle surfaces the backend error without changing state, invalidating, or refetching', async () => {
  const current = [skill('/one/SKILL.md', true), skill('/two/SKILL.md', true)];
  let invalidated = false;
  let refetched = false;

  await assert.rejects(mutateOpenCodeSkillAccess({
    skill: current[0],
    enabled: false,
    skills: current,
    updateAccess: async () => { throw new Error('Permission update rejected'); },
    invalidateCache: () => { invalidated = true; },
    refetch: async () => { refetched = true; return []; },
  }), /Permission update rejected/);

  assert.deepEqual(current.map(({ enabled }) => enabled), [true, true]);
  assert.equal(invalidated, false);
  assert.equal(refetched, false);
});
