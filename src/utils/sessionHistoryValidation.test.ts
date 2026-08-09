import assert from 'node:assert/strict';
import test from 'node:test';

import { validateSessionHistoryMessageChunk } from '../../shared/cloudcli-contracts';

import {
  parseSessionHistoryEnvelopeAsync,
  SessionHistoryWorkerPool,
  type SessionHistoryWorkerLike,
  type SessionHistoryWorkerRequest,
  type SessionHistoryWorkerResponse,
} from './sessionHistoryValidation';

function message(index: number) {
  return { id: `m${index}`, sessionId: 's1', timestamp: '2026-08-09T00:00:00Z', provider: 'claude', kind: 'text', content: `row ${index}` };
}

function envelope(messages: unknown[]) {
  return { protocolVersion: 1, success: true, data: { revision: 'r1', messages, total: messages.length, hasMore: false, offset: 0, limit: null } };
}

class ControlledWorkers {
  created = 0;
  active = 0;
  maximum = 0;
  pending: Array<() => void> = [];
  failConstruction = false;

  factory = (): SessionHistoryWorkerLike => {
    if (this.failConstruction) throw new Error('unsupported');
    this.created += 1;
    const worker: SessionHistoryWorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage: (request: SessionHistoryWorkerRequest) => {
        this.active += 1;
        this.maximum = Math.max(this.maximum, this.active);
        this.pending.push(() => {
          this.active -= 1;
          worker.onmessage?.({ data: { id: request.id, result: validateSessionHistoryMessageChunk(request.messages, request.startIndex) } } as MessageEvent<SessionHistoryWorkerResponse>);
        });
      },
      terminate() {},
    };
    return worker;
  };

  flush(): void {
    while (this.pending.length > 0) this.pending.shift()!();
  }
}

test('small histories remain synchronous and preserve original references', async () => {
  const workers = new ControlledWorkers();
  const pool = new SessionHistoryWorkerPool(workers.factory, 2);
  const rows = [message(0), message(1)];
  const result = await parseSessionHistoryEnvelopeAsync(envelope(rows), { pool, threshold: 3 });
  assert.equal(result.ok, true);
  assert.equal(workers.created, 0);
  if (result.ok) {
    assert.equal(result.value.data.messages[0], rows[0]);
    assert.equal(result.value.data.messages[1], rows[1]);
  }
});

test('large and simultaneous histories share bounded reusable workers', async () => {
  const workers = new ControlledWorkers();
  const pool = new SessionHistoryWorkerPool(workers.factory, 2);
  const first = parseSessionHistoryEnvelopeAsync(envelope(Array.from({ length: 12 }, (_, i) => message(i))), { pool, threshold: 1 });
  const second = parseSessionHistoryEnvelopeAsync(envelope(Array.from({ length: 12 }, (_, i) => message(i + 20))), { pool, threshold: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workers.active, 2);
  workers.flush();
  const results = await Promise.all([first, second]);
  assert.equal(results.every((result) => result.ok), true);
  assert.equal(workers.maximum, 2);
  assert.equal(workers.created, 2);
});

test('racing chunk failures return the lowest global message index', async () => {
  const workers = new ControlledWorkers();
  const pool = new SessionHistoryWorkerPool(workers.factory, 2);
  const rows = Array.from({ length: 8 }, (_, i) => message(i));
  rows[1] = { ...rows[1], provider: 'bad' } as ReturnType<typeof message>;
  rows[6] = { ...rows[6], kind: 'bad' } as ReturnType<typeof message>;
  const pending = parseSessionHistoryEnvelopeAsync(envelope(rows), { pool, threshold: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  workers.pending.reverse();
  workers.flush();
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.path, '$.data.messages[1].provider');
});

test('abort rejects and removes queued validation work', async () => {
  const workers = new ControlledWorkers();
  const pool = new SessionHistoryWorkerPool(workers.factory, 1);
  const controller = new AbortController();
  const pending = parseSessionHistoryEnvelopeAsync(envelope(Array.from({ length: 8 }, (_, i) => message(i))), { pool, threshold: 1, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  workers.flush();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(workers.pending.length, 0);
});

test('worker construction failure falls back to strict synchronous parsing', async () => {
  const workers = new ControlledWorkers();
  workers.failConstruction = true;
  const pool = new SessionHistoryWorkerPool(workers.factory, 2);
  const rows = Array.from({ length: 4 }, (_, i) => message(i));
  rows[2] = { ...rows[2], id: '' };
  const result = await parseSessionHistoryEnvelopeAsync(envelope(rows), { pool, threshold: 1 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.path, '$.data.messages[2].id');
});
