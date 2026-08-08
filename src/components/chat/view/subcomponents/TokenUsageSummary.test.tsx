import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import TokenUsageSummary from './TokenUsageSummary';
import {
  buildTokenUsageBadgeState,
  calculateTokenUsagePercentage,
  formatTokenCount,
  formatTokenUsagePercentage,
} from './TokenUsageSummary.utils';

test('uses current-window tokens instead of cumulative usage for the composer badge', () => {
  const summary = buildTokenUsageBadgeState({ used: 42_000, windowTokens: 12_000, total: 200_000 });

  assert.equal(summary.displayLabel, '12K / 200K · 6%');
  assert.equal(summary.current, 12_000);
  assert.equal(summary.maximum, 200_000);
  assert.equal(summary.percentage, 6);
  assert.equal(summary.hasCurrentWindow, true);
  assert.match(summary.title, /12,000 current context tokens; 200,000-token capacity \(6% of context window\)/);
  assert.match(summary.ariaLabel, /Current context: 12,000 of 200,000 tokens, 6% of context window capacity/);
});

test('does not fall back to cumulative or input/output usage when current-window tokens are absent', () => {
  const summary = buildTokenUsageBadgeState({
    used: 42_000,
    inputTokens: 12_000,
    outputTokens: 3_000,
    total: 20_000,
  });

  assert.equal(summary.hasSnapshot, true);
  assert.equal(summary.hasCurrentWindow, false);
  assert.equal(summary.current, null);
  assert.equal(summary.displayLabel, '—');
  assert.equal(summary.maximum, 20_000);
  assert.equal(summary.percentage, null);
  assert.match(summary.title, /Current context unavailable; context window capacity is 20,000 tokens/);
  assert.match(summary.ariaLabel, /Current context unavailable/);
});

test('shows current-window usage only when the capacity is unknown or non-positive', () => {
  for (const total of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const summary = buildTokenUsageBadgeState({ used: 99_000, windowTokens: 42_000, total });

    assert.equal(summary.displayLabel, '42K tokens');
    assert.equal(summary.current, 42_000);
    assert.equal(summary.maximum, null);
    assert.equal(summary.percentage, null);
    assert.match(summary.title, /42,000 current context tokens; context window capacity unavailable/);
    assert.match(summary.ariaLabel, /Current context: 42,000 tokens; context window capacity unavailable/);
  }
});

test('uses a neutral unavailable state when there is no current-window data', () => {
  const summary = buildTokenUsageBadgeState(null);
  const html = renderToStaticMarkup(React.createElement(TokenUsageSummary, { usage: null }));

  assert.equal(summary.hasSnapshot, false);
  assert.equal(summary.hasCurrentWindow, false);
  assert.equal(summary.current, null);
  assert.equal(summary.displayLabel, '—');
  assert.doesNotMatch(summary.title, /0 tokens/);
  assert.match(html, />—</);
  assert.match(html, /current context unavailable/);
  assert.match(html, /Current context unavailable while waiting for a usage snapshot/);
  assert.doesNotMatch(html, /0 tokens/);
});

test('keeps the current count visible while the compact max/percentage text is responsive', () => {
  const html = renderToStaticMarkup(
    React.createElement(TokenUsageSummary, { usage: { used: 42_000, windowTokens: 12_000, total: 200_000 } }),
  );

  assert.match(html, />12K</);
  assert.doesNotMatch(html, />42K</);
  assert.match(html, /sm:inline[^>]*> \/ 200K · 6%|> \/ 200K · 6%<\/span>/);
  assert.match(html, /aria-label="Current context: 12,000 of 200,000 tokens, 6% of context window capacity/);
});

test('treats a reported zero current-window count as real data', () => {
  const summary = buildTokenUsageBadgeState({ used: 42_000, windowTokens: 0, total: 200_000 });

  assert.equal(summary.hasCurrentWindow, true);
  assert.equal(summary.current, 0);
  assert.equal(summary.displayLabel, '0 / 200K · 0%');
  assert.match(summary.title, /0 current context tokens; 200,000-token capacity \(0% of context window\)/);
  assert.match(summary.ariaLabel, /Current context: 0 of 200,000 tokens, 0% of context window capacity/);
});

test('formats token counts compactly and rounds displayed percentages', () => {
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1_000), '1.0K');
  assert.equal(formatTokenCount(12_345), '12K');
  assert.equal(formatTokenCount(1_250_000), '1.3M');
  assert.equal(formatTokenUsagePercentage(12.5), '13%');
});

test('clamps percentages to zero through one hundred when counters are outside the window', () => {
  assert.equal(calculateTokenUsagePercentage(42_000, 200_000), 21);
  assert.equal(calculateTokenUsagePercentage(250_000, 200_000), 100);
  assert.equal(calculateTokenUsagePercentage(-1, 200_000), 0);
  assert.equal(calculateTokenUsagePercentage(42_000, 0), null);
  assert.equal(
    buildTokenUsageBadgeState({ used: 999_000, windowTokens: 250_000, total: 200_000 }).displayLabel,
    '250K / 200K · 100%',
  );
  assert.equal(
    buildTokenUsageBadgeState({ used: 999_000, windowTokens: -1, total: 200_000 }).displayLabel,
    '0 / 200K · 0%',
  );
});
