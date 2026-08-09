import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLOUDCLI_PROTOCOL_VERSION,
  parseApiErrorEnvelope,
  parseApiSuccessEnvelope,
  parseChatSubscribeCommand,
  parseChatSubscribedEvent,
  parseNormalizedMessage,
  parseSequencedChatEvent,
  parseSessionHistoryEnvelope,
  parseSessionHistoryEnvelopeStructure,
  parseSessionLifecycleSnapshot,
  validateSessionHistoryMessageChunk,
} from './cloudcli-contracts.js';

const message = { id: 'm1', sessionId: 's1', timestamp: '2026-08-09T00:00:00.000Z', provider: 'opencode', kind: 'text', content: 'hello' };
const context = {
  sessionId: 's1', provider: 'opencode', parentSessionId: null,
  session: { id: 's1', provider: 'opencode', model: null, agent: null, summary: 'Chat', lastActivity: 'now' },
  project: { projectId: 'p1', path: '/p', fullPath: '/p', displayName: 'P', isStarred: false },
};

test('parses API envelopes and reports missing error fields', () => {
  assert.deepEqual(parseApiSuccessEnvelope({ success: true, data: 'ok' }, (value: unknown) => ({ ok: true, value: String(value) })), { ok: true, value: { success: true, data: 'ok' } });
  const error = parseApiErrorEnvelope({ success: false, error: { message: 'bad' } });
  assert.equal(error.ok, false);
  if (!error.ok) assert.equal(error.error.code, 'MISSING_FIELD');
});

test('accepts existing normalized messages and rejects missing required fields deterministically', () => {
  assert.equal(parseNormalizedMessage(message).ok, true);
  const result = parseNormalizedMessage({ ...message, sessionId: undefined });
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual({ code: result.error.code, path: result.error.path }, { code: 'INVALID_FIELD', path: '$.sessionId' });
});

test('parses versioned normalized session history', () => {
  assert.equal(parseSessionHistoryEnvelope({ protocolVersion: 1, success: true, data: { revision: 'rev-1', messages: [message], total: 1, hasMore: false, offset: 0, limit: null } }).ok, true);
  const result = parseSessionHistoryEnvelope({ protocolVersion: 99, success: true, data: {} });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'UNSUPPORTED_PROTOCOL_VERSION');
});

test('decomposes history structure and indexed message validation without cloning message references', () => {
  const secondMessage = { ...message, id: 'm2' };
  const input = { protocolVersion: 1, success: true, requestId: 'request-1', data: { revision: 'rev-1', messages: [message, secondMessage], total: 2, hasMore: false, offset: 0, limit: null, tokenUsage: { input: 2 } } };
  const structure = parseSessionHistoryEnvelopeStructure(input);
  assert.equal(structure.ok, true);
  if (structure.ok) assert.equal(structure.value.data.messages, input.data.messages);

  const chunk = validateSessionHistoryMessageChunk(input.data.messages.slice(1), 1);
  assert.equal(chunk.ok, true);
  if (chunk.ok) assert.equal(chunk.value[0], secondMessage);

  const parsed = parseSessionHistoryEnvelope(input);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.value, input);
    assert.equal(parsed.value.data.messages[0], message);
    assert.equal(parsed.value.data.messages[1], secondMessage);
  }
});

test('reports structural and globally indexed history failures deterministically', () => {
  const malformedMetadata = parseSessionHistoryEnvelopeStructure({ protocolVersion: 1, success: true, data: { revision: '', messages: [], total: 0, hasMore: false, offset: 0, limit: null } });
  assert.equal(malformedMetadata.ok, false);
  if (!malformedMetadata.ok) assert.deepEqual({ code: malformedMetadata.error.code, path: malformedMetadata.error.path }, { code: 'INVALID_FIELD', path: '$.data.revision' });

  const malformedChunk = validateSessionHistoryMessageChunk([
    { ...message, id: 'm7' },
    { ...message, id: 'm8', provider: 'unknown' },
    { ...message, id: '', provider: 'unknown' },
  ], 7);
  assert.equal(malformedChunk.ok, false);
  if (!malformedChunk.ok) {
    assert.equal(malformedChunk.messageIndex, 8);
    assert.deepEqual({ code: malformedChunk.error.code, path: malformedChunk.error.path }, { code: 'INVALID_FIELD', path: '$.data.messages[8].provider' });
  }
});

test('keeps synchronous history failure precedence and exact paths compatible', () => {
  const result = parseSessionHistoryEnvelope({ protocolVersion: 1, success: true, requestId: 123, data: { revision: '', messages: [{ ...message, sessionId: undefined }], total: 'bad', hasMore: false, offset: 0, limit: null } });
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual({ code: result.error.code, path: result.error.path }, { code: 'INVALID_FIELD', path: '$.data.messages[0].sessionId' });
});

test('parses lifecycle snapshots and rejects malformed required fields', () => {
  const valid = { ...context, status: 'running', statusText: null, lastActivityAt: 1, restartable: false, canInterrupt: true, terminalReason: null, exitCode: null };
  assert.equal(parseSessionLifecycleSnapshot(valid).ok, true);
  assert.equal(parseSessionLifecycleSnapshot({ ...valid, session: { ...valid.session, summary: '' } }).ok, true);
  const invalid = parseSessionLifecycleSnapshot({ ...valid, canInterrupt: 'yes' });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.path, '$.canInterrupt');
});

test('parses subscribe, acknowledgement and sequenced events with version checks', () => {
  assert.equal(parseChatSubscribeCommand({ type: 'chat.subscribe', protocolVersion: CLOUDCLI_PROTOCOL_VERSION, sessions: [{ sessionId: 's1', generation: 2, lastSeq: 4 }] }).ok, true);
  assert.equal(parseChatSubscribedEvent({ kind: 'chat_subscribed', protocolVersion: 1, sessionId: 's1', historyRevision: 'rev-1', generation: 2, isProcessing: true, lastSeq: 4, replayFromSeq: null, replayToSeq: null, replayGap: false, refreshRequired: false, pendingPermissions: [], timestamp: 'now' }).ok, true);
  assert.equal(parseSequencedChatEvent({ ...message, protocolVersion: 1, generation: 2, seq: 5 }).ok, true);
  const mismatch = parseSequencedChatEvent({ ...message, protocolVersion: 2, generation: 2, seq: 5 });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.error.code, 'UNSUPPORTED_PROTOCOL_VERSION');
});
