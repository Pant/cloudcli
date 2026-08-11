import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatAthensResponseTimestamp,
  formatResponseMetadata,
  formatResponseTokenCount,
} from './responseMetadata';

test('formats an unambiguous numeric Athens date with 24-hour time', () => {
  assert.equal(formatAthensResponseTimestamp('2026-04-08T10:05:00Z'), '8/4/2026 13:05');
});

test('uses Europe/Athens daylight-saving transitions instead of a fixed offset', () => {
  assert.equal(formatAthensResponseTimestamp('2026-01-15T10:00:00Z'), '15/1/2026 12:00');
  assert.equal(formatAthensResponseTimestamp('2026-07-15T10:00:00Z'), '15/7/2026 13:00');
});

test('omits invalid timestamps and metadata safely', () => {
  assert.equal(formatAthensResponseTimestamp('not-a-date'), null);
  assert.equal(formatResponseMetadata({ inputTokens: 1, outputTokens: 2, timestamp: 'invalid' }), null);
  assert.equal(formatResponseMetadata({ inputTokens: -1, outputTokens: 2, timestamp: '2026-04-08T10:00:00Z' }), null);
});

test('formats token counts compactly and deterministically', () => {
  assert.equal(formatResponseTokenCount(0), '0');
  assert.equal(formatResponseTokenCount(999), '999');
  assert.equal(formatResponseTokenCount(1_234), '1.2K');
  assert.equal(formatResponseTokenCount(12_345), '12.3K');
  assert.equal(formatResponseTokenCount(1_000_000), '1M');
  assert.equal(formatResponseTokenCount(Number.NaN), null);
  assert.equal(formatResponseTokenCount(1.5), null);
});
