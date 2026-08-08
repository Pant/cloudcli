import assert from 'node:assert/strict';
import test from 'node:test';

import { stabilizeTokenUsageSnapshot } from './tokenUsageSnapshot';

test('preserves the last current-window value when a later snapshot omits it', () => {
  const previous = { used: 40_000, windowTokens: 12_000, total: 200_000 };
  const next = stabilizeTokenUsageSnapshot(previous, { used: 45_000, inputTokens: 30_000 });

  assert.deepEqual(next, {
    used: 45_000,
    windowTokens: 12_000,
    total: 200_000,
    inputTokens: 30_000,
  });
});

test('preserves a trustworthy value when the incoming current-window field is malformed', () => {
  const previous = { used: 40_000, windowTokens: 12_000 };

  for (const malformed of [null, undefined, '', 'not-a-number', Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const next = stabilizeTokenUsageSnapshot(previous, { used: 45_000, windowTokens: malformed });
    assert.equal(next?.windowTokens, 12_000);
  }

  assert.equal(stabilizeTokenUsageSnapshot(null, { used: 45_000, windowTokens: 'not-a-number' })?.windowTokens, undefined);
});

test('ignores a provider placeholder zero when cumulative usage is nonzero', () => {
  const previous = { used: 40_000, windowTokens: 12_000 };
  const next = stabilizeTokenUsageSnapshot(previous, {
    used: 45_000,
    inputTokens: 42_000,
    outputTokens: 3_000,
    windowTokens: 0,
  });

  assert.equal(next?.windowTokens, 12_000);
  assert.equal(next?.used, 45_000);
});

test('accepts a real zero current-window value when cumulative usage is zero', () => {
  const next = stabilizeTokenUsageSnapshot(
    { used: 40_000, windowTokens: 12_000 },
    { used: 0, inputTokens: 0, outputTokens: 0, windowTokens: 0 },
  );

  assert.equal(next?.windowTokens, 0);
});

test('accepts legitimate current-window decreases, including compaction', () => {
  const afterResponse = stabilizeTokenUsageSnapshot(
    { used: 90_000, windowTokens: 80_000 },
    { used: 95_000, windowTokens: 35_000 },
  );
  const afterCompaction = stabilizeTokenUsageSnapshot(
    afterResponse,
    { used: 100_000, windowTokens: 20_000 },
  );

  assert.equal(afterResponse?.windowTokens, 35_000);
  assert.equal(afterCompaction?.windowTokens, 20_000);
});

test('normalizes the legacy snake-case field without allowing it to erase state', () => {
  const next = stabilizeTokenUsageSnapshot(
    { used: 12_000, windowTokens: 4_000 },
    { used: 13_000, window_tokens: 5_000 },
  );

  assert.equal(next?.windowTokens, 5_000);
  assert.equal(Object.prototype.hasOwnProperty.call(next ?? {}, 'window_tokens'), false);
});

test('an explicit session reset remains null and cannot retain the prior value', () => {
  const prior = stabilizeTokenUsageSnapshot(null, { used: 20_000, windowTokens: 8_000 });
  const reset = null;
  const nextSession = stabilizeTokenUsageSnapshot(reset, { used: 0, windowTokens: 0 });

  assert.equal(prior?.windowTokens, 8_000);
  assert.equal(nextSession?.windowTokens, 0);
});
