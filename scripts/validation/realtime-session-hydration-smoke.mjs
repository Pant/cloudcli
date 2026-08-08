import assert from 'node:assert/strict';

import { chatRunRegistry } from '../../server/modules/websocket/services/chat-run-registry.service.ts';
import {
  acceptSequencedEvent,
  reduceRealtimeStream,
} from '../../src/stores/sessionStore.helpers.ts';
import {
  advanceViewportSettle,
  chooseViewportSnapshot,
  shouldPinViewport,
} from '../../src/components/chat/hooks/sessionViewport.ts';
import { normalizedToChatMessages } from '../../src/components/chat/hooks/useChatMessages.ts';

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

chatRunRegistry.clearAll();
console.log('realtime/session hydration smoke passed');
