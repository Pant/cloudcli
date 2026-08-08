import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { chatRunRegistry } from '../../server/modules/websocket/services/chat-run-registry.service.ts';
import {
  acceptSequencedEvent,
  reduceRealtimeStream,
} from '../../src/stores/sessionStore.helpers.ts';
import {
  advanceViewportSettle,
  chooseViewportSnapshot,
  shouldPinViewport,
  shouldApplyViewportRevision,
} from '../../src/components/chat/hooks/sessionViewport.ts';
import { normalizedToChatMessages } from '../../src/components/chat/hooks/useChatMessages.ts';
import {
  createSessionIdentity,
  isCommittedIdentityCurrent,
  resolveCommittedSessionIdentity,
} from '../../src/components/chat/hooks/sessionSelection.ts';

const connection = () => ({ readyState: 1, sent: [], send(payload) { this.sent.push(JSON.parse(payload)); } });
const event = (sessionId, kind, content = '') => ({
  id: `${sessionId}-${kind}-${content}`,
  kind,
  provider: 'opencode',
  sessionId: `provider-${sessionId}`,
  timestamp: '2026-08-07T00:00:00.000Z',
  content,
});

function ingest(state, message) {
  const result = acceptSequencedEvent(state.cursor, message.generation, message.seq);
  if (result.status !== 'accepted') return result;
  state.cursor = result.cursor;
  state.accepted.push(message.seq);
  state.stream = reduceRealtimeStream(state.stream, message);
  if (message.kind === 'complete') state.terminalEffects += 1;
  return result;
}

chatRunRegistry.clearAll();
const liveSocket = connection();
const runA = chatRunRegistry.startRun({
  appSessionId: 'session-a', provider: 'opencode', providerSessionId: null,
  connection: liveSocket, userId: null, generation: 11,
});
assert.ok(runA);
runA.writer.send(event('a', 'stream_delta', 'one'));
runA.writer.send(event('a', 'stream_delta', '-two'));

const stateA = { cursor: null, accepted: [], stream: null, terminalEffects: 0 };
assert.equal(ingest(stateA, liveSocket.sent[0]).status, 'accepted');
chatRunRegistry.detachConnection(liveSocket);
runA.writer.send(event('a', 'stream_delta', '-missed'));

const reconnect = connection();
const replay = chatRunRegistry.beginSubscription('session-a', reconnect, 11, 1);
assert.deepEqual(replay.events.map((item) => item.seq), [2, 3]);
assert.equal(replay.refreshRequired, false);
for (const item of replay.events) ingest(stateA, item);
assert.deepEqual(stateA.accepted, [1, 2, 3]);
assert.equal(stateA.stream.content, 'one-two-missed');
assert.equal(ingest(stateA, replay.events[0]).status, 'duplicate');
chatRunRegistry.finishSubscription('session-a', reconnect);

runA.writer.send(event('a', 'complete'));
const complete = reconnect.sent.at(-1);
assert.equal(ingest(stateA, complete).status, 'accepted');
assert.equal(ingest(stateA, complete).status, 'duplicate');
assert.equal(stateA.terminalEffects, 1);

const runB = chatRunRegistry.startRun({
  appSessionId: 'session-b', provider: 'opencode', providerSessionId: null,
  connection: null, userId: null, generation: 4,
});
assert.ok(runB);
runB.writer.send(event('b', 'stream_delta', 'independent'));
const stateB = { cursor: null, accepted: [], stream: null, terminalEffects: 0 };
ingest(stateB, chatRunRegistry.replayEvents('session-b', 0)[0]);
assert.equal(stateB.stream.content, 'independent');
assert.equal(stateA.stream, null);

runB.writer.send(event('b', 'complete'));
const rollover = chatRunRegistry.startRun({
  appSessionId: 'session-b', provider: 'opencode', providerSessionId: null,
  connection: null, userId: null, generation: 5,
});
assert.ok(rollover);
rollover.writer.send(event('b', 'text', 'new generation'));
const rolloverEvent = chatRunRegistry.replayEvents('session-b', 0)[0];
assert.equal(ingest(stateB, rolloverEvent).status, 'accepted');
assert.deepEqual(stateB.cursor, { generation: 5, seq: 1 });

const gap = chatRunRegistry.startRun({
  appSessionId: 'session-gap', provider: 'opencode', providerSessionId: null,
  connection: null, userId: null, generation: 1,
});
assert.ok(gap);
for (let index = 0; index < 5001; index += 1) gap.writer.send(event('gap', 'status', String(index)));
const gapSnapshot = chatRunRegistry.beginSubscription('session-gap', connection(), 1, 0);
assert.equal(gapSnapshot.replayGap, true);
assert.equal(gapSnapshot.refreshRequired, true);
assert.deepEqual(gapSnapshot.events, []);
assert.equal(acceptSequencedEvent({ generation: 1, seq: 1 }, 1, 3).status, 'gap');

const hydrated = normalizedToChatMessages([{
  ...event('a', 'text', 'stable'), id: 'stable-message-id', sessionId: 'session-a',
  role: 'assistant', generation: 11, seq: 9,
}]);
assert.equal(hydrated[0].id, 'stable-message-id');
assert.equal(hydrated[0].generation, 11);
assert.equal(hydrated[0].seq, 9);

const savedA = chooseViewportSnapshot(
  { scrollTop: 200, scrollHeight: 1000, clientHeight: 400 },
  { key: 'stable-message-id', offset: 17 },
);
const savedB = chooseViewportSnapshot(
  { scrollTop: 590, scrollHeight: 1000, clientHeight: 400 },
  { key: 'b-id', offset: 4 },
);
assert.deepEqual(savedA, { mode: 'anchor', key: 'stable-message-id', offset: 17 });
assert.deepEqual(savedB, { mode: 'bottom', bottomDistance: 10 });
assert.equal(shouldPinViewport({ saved: savedA, searchActive: false, firstOpen: false }), false);
assert.equal(shouldPinViewport({ saved: savedB, searchActive: false, firstOpen: false }), true);
let settle = { frame: 0, stableFrames: 0, lastMeasurement: null };
for (const measurement of [10, 10, 10, 10]) ({ state: settle } = advanceViewportSettle(settle, measurement));
assert.equal(advanceViewportSettle(settle, 10).done, true);

// Reproduce the rapid A -> transient null -> B -> A selection sequence. The
// committed identity is the render boundary: null cannot expose A, and a stale
// completion captured for A cannot mutate B.
const selectedA = createSessionIdentity('selected', 'session-a', 'project');
const selectedB = createSessionIdentity('selected', 'session-b', 'project');
const resolveSelection = (selectedSessionId) => resolveCommittedSessionIdentity({
  selectedSessionId,
  projectId: 'project',
  draft: null,
});
assert.equal(resolveSelection('session-a').key, selectedA.key);
assert.equal(resolveSelection(null), null);
assert.equal(resolveSelection('session-b').key, selectedB.key);
assert.equal(isCommittedIdentityCurrent(selectedA, selectedB), false);

// Simultaneous updates and stream growth remain owned by their session slots.
const slots = new Map([
  ['session-a', { rows: ['a-older'], stream: '' }],
  ['session-b', { rows: ['b-older'], stream: '' }],
]);
slots.get('session-a').rows.push('a-concurrent');
slots.get('session-a').stream += 'a-growing';
slots.get('session-b').rows.push('b-concurrent');
slots.get('session-b').stream += 'b-growing';
const visibleRows = (identity) => identity
  ? [...slots.get(identity.sessionId).rows, slots.get(identity.sessionId).stream]
  : [];
assert.deepEqual(visibleRows(selectedB), ['b-older', 'b-concurrent', 'b-growing']);
assert.deepEqual(visibleRows(null), []);

let selectedView = selectedB;
const staleFetchIdentity = selectedA;
const staleFetchRows = ['a-stale-fetch'];
if (isCommittedIdentityCurrent(staleFetchIdentity, selectedView)) {
  slots.get(staleFetchIdentity.sessionId).rows = staleFetchRows;
}
assert.deepEqual(visibleRows(selectedView), ['b-older', 'b-concurrent', 'b-growing']);
assert.deepEqual(slots.get('session-a').rows, ['a-older', 'a-concurrent']);

// Returning to A restores A's own anchor after its latest background update;
// B's revision cannot trigger viewport work while A is selected.
selectedView = resolveSelection('session-a');
assert.deepEqual(visibleRows(selectedView), ['a-older', 'a-concurrent', 'a-growing']);
assert.deepEqual(savedA, { mode: 'anchor', key: 'stable-message-id', offset: 17 });
assert.equal(shouldApplyViewportRevision({
  expectedIdentityKey: selectedB.key,
  currentIdentityKey: selectedView.key,
  previousRevision: 1,
  nextRevision: 2,
  searchActive: false,
}), false);
assert.equal(shouldApplyViewportRevision({
  expectedIdentityKey: selectedA.key,
  currentIdentityKey: selectedView.key,
  previousRevision: 1,
  nextRevision: 2,
  searchActive: false,
}), true);

// Dynamic rows must expose actual normal-flow geometry to viewport anchoring.
const css = await readFile(new URL('../../src/index.css', import.meta.url), 'utf8');
const chatMessageRules = [...css.matchAll(/\.chat-message\s*\{([^}]*)\}/g)].map((match) => match[1]);
assert.ok(chatMessageRules.length > 0);
for (const rule of chatMessageRules) {
  assert.doesNotMatch(rule, /content-visibility\s*:/);
  assert.doesNotMatch(rule, /contain-intrinsic-size\s*:/);
  assert.doesNotMatch(rule, /contain\s*:\s*[^;]*(?:layout|paint)/);
}
assert.doesNotMatch(css, /\.chat-message[^{}]*\{[^}]*contain-intrinsic-size\s*:/s);

chatRunRegistry.clearAll();
console.log('realtime/session hydration smoke passed');
