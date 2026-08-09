import assert from 'node:assert/strict';
import test from 'node:test';

import { CONSOLE_LEVELS, createConsoleCapture, formatConsoleArguments } from './consoleCapture';

function makeConsoleDouble() {
  const calls: Array<{ level: string; receiver: unknown; args: unknown[] }> = [];
  const target = Object.fromEntries(CONSOLE_LEVELS.map(level => [level, function (this: unknown, ...args: unknown[]) {
    calls.push({ level, receiver: this, args });
  }])) as Pick<Console, (typeof CONSOLE_LEVELS)[number]>;
  return { calls, target };
}

test('captures every supported level in order and delegates unchanged exactly once', () => {
  let tick = 0;
  const capture = createConsoleCapture(() => new Date(`2026-01-01T00:00:0${tick++}.000Z`));
  const { calls, target } = makeConsoleDouble();
  capture.install(target);

  for (const level of CONSOLE_LEVELS) target[level]('line one\nline two', 7);

  assert.deepEqual(capture.getSnapshot().map(entry => entry.level), CONSOLE_LEVELS);
  assert.equal(capture.getSnapshot()[0].timestamp, '2026-01-01T00:00:00.000Z');
  assert.equal(capture.getSnapshot()[0].text, 'line one\nline two 7');
  assert.equal(calls.length, CONSOLE_LEVELS.length);
  calls.forEach((call, index) => {
    assert.equal(call.receiver, target);
    assert.deepEqual(call.args, ['line one\nline two', 7]);
    assert.equal(call.level, CONSOLE_LEVELS[index]);
  });
});

test('installation is idempotent and subscribers can read prior and new messages', () => {
  const capture = createConsoleCapture();
  const { calls, target } = makeConsoleDouble();
  capture.install(target);
  capture.install(target);
  target.log('before');
  assert.equal(capture.getSnapshot().length, 1);

  let notifications = 0;
  const unsubscribe = capture.subscribe(() => notifications++);
  target.warn('after');
  unsubscribe();
  target.error('later');

  assert.equal(notifications, 1);
  assert.deepEqual(capture.getSnapshot().map(entry => entry.text), ['before', 'after', 'later']);
  assert.equal(calls.length, 3);
});

test('formats circular, error, bigint, symbol, accessor, and hostile values without throwing', () => {
  const circular: Record<string, unknown> = { nested: { ok: true } };
  circular.self = circular;
  const accessor = Object.defineProperty({}, 'danger', { get() { throw new Error('no'); } });
  const hostile = new Proxy({}, { ownKeys() { throw new Error('no keys'); } });
  const text = formatConsoleArguments([circular, new Error('boom'), 12n, Symbol('token'), accessor, hostile]);

  assert.match(text, /\[Circular\]/);
  assert.match(text, /boom/);
  assert.match(text, /12n/);
  assert.match(text, /Symbol\(token\)/);
  assert.match(text, /\[Accessor\]/);
  assert.match(text, /\{\}/);
});
