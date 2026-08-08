import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { CostCommandData } from '../../hooks/useChatComposerState';

import { CostContent } from './CommandResultModal';
import { getTokenUsageDetails } from './CommandResultModalCostContent.utils';

test('builds context details while retaining total, input, and output usage', () => {
  const details = getTokenUsageDetails({ used: 42_000, windowTokens: 12_000, total: 200_000 });

  assert.deepEqual(details, {
    used: 42_000,
    windowTokens: 12_000,
    maximum: 200_000,
    windowPercentage: 6,
    remaining: 188_000,
    visualPercentage: 6,
  });

  const html = renderToStaticMarkup(
    React.createElement(CostContent, {
      data: {
         tokenUsage: { used: 42_000, windowTokens: 12_000, total: 200_000 },
        tokenBreakdown: { input: 30_000, output: 12_000 },
        provider: 'claude',
        model: 'claude-sonnet',
      } satisfies CostCommandData,
    }),
  );

  assert.match(html, /Total tokens used/);
  assert.match(html, /Input tokens/);
  assert.match(html, /Output tokens/);
  assert.match(html, />42,000<\/span>/);
  assert.match(html, />30,000<\/span>/);
  assert.match(html, />12,000<\/span>/);
  assert.match(html, /Current context tokens/);
  assert.match(html, /Context window maximum/);
  assert.match(html, /Current context percentage/);
  assert.match(html, /Remaining context tokens/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuenow="6"/);
  assert.match(html, /12,000 of 200,000 current context-window tokens occupied \(6%\)/);
  assert.doesNotMatch(html, /42,000 of 200,000/);
});

test('clamps an over-limit visual meter and never reports negative remaining context', () => {
  assert.deepEqual(getTokenUsageDetails({ used: 10_000, windowTokens: 250, total: 200 }), {
    used: 10_000,
    windowTokens: 250,
    maximum: 200,
    windowPercentage: 100,
    remaining: 0,
    visualPercentage: 100,
  });
});

test('does not use cumulative usage as current context when occupancy is absent', () => {
  for (const tokenUsage of [
    { used: 42_000, total: 200_000 },
    { used: 42_000, windowTokens: null, total: 200_000 },
    { used: 42_000, windowTokens: 12_000, total: 0 },
    { used: 42_000, windowTokens: 12_000, total: -1 },
  ]) {
    const details = getTokenUsageDetails(tokenUsage);

    if (!('windowTokens' in tokenUsage)) {
      assert.equal(details.windowTokens, null);
    }
    assert.equal(details.maximum, tokenUsage.total && tokenUsage.total > 0 ? 200_000 : null);
    assert.equal(details.windowPercentage, null);
    assert.equal(details.remaining, null);
    assert.equal(details.visualPercentage, null);
  }

  const html = renderToStaticMarkup(
    React.createElement(CostContent, {
      data: {
         tokenUsage: { used: 42_000, total: 0 },
        tokenBreakdown: { input: 30_000, output: 12_000 },
        provider: 'opencode',
        model: 'cloudcli-openai/model',
      } satisfies CostCommandData,
    }),
  );

  assert.match(html, /Total tokens used/);
  assert.match(html, /Input tokens/);
  assert.match(html, /Output tokens/);
  assert.match(html, /Current context tokens/);
  assert.match(html, /Current context-window occupancy unavailable/);
  assert.match(html, /Cumulative session totals above remain available/);
  assert.doesNotMatch(html, /role="progressbar"/);
  assert.match(html, /Provider[\s\S]*OpenCode/);
  assert.match(html, /cloudcli-openai\/model/);
});

test('does not render a context meter from cumulative usage when current occupancy is absent', () => {
  const html = renderToStaticMarkup(
    React.createElement(CostContent, {
      data: {
        tokenUsage: { used: 42_000, total: 200_000 },
        tokenBreakdown: { input: 30_000, output: 12_000 },
        provider: 'claude',
        model: 'claude-sonnet',
      } satisfies CostCommandData,
    }),
  );

  assert.match(html, /Total tokens used/);
  assert.match(html, />42,000<\/span>/);
  assert.match(html, /Current context tokens/);
  assert.match(html, /Current context-window occupancy unavailable/);
  assert.doesNotMatch(html, /role="progressbar"/);
  assert.doesNotMatch(html, /42,000 of 200,000/);
});

test('keeps current occupancy informative when context capacity is absent', () => {
  const html = renderToStaticMarkup(
    React.createElement(CostContent, {
      data: {
        tokenUsage: { used: 42_000, windowTokens: 12_000 },
        tokenBreakdown: { input: 30_000, output: 12_000 },
        provider: 'claude',
        model: 'claude-sonnet',
      } satisfies CostCommandData,
    }),
  );

  assert.match(html, /12,000/);
  assert.match(html, /Current context-window occupancy unavailable/);
  assert.match(html, /has not reported a positive context-window maximum/);
  assert.doesNotMatch(html, /role="progressbar"/);
});
