import {
  parseSessionHistoryEnvelope,
  parseSessionHistoryEnvelopeStructure,
  validateSessionHistoryMessageChunk,
  type ContractParseFailure,
  type ContractParseResult,
  type SessionHistoryEnvelope,
  type SessionHistoryMessageChunkResult,
} from '../../shared/cloudcli-contracts';

export const SESSION_HISTORY_WORKER_THRESHOLD = 256;
export const SESSION_HISTORY_TASKS_PER_WORKER = 2;
export const SESSION_HISTORY_MAX_WORKERS = 4;
export const SESSION_HISTORY_MIN_MESSAGES_PER_TASK = 256;

export type SessionHistoryWorkerRequest = {
  id: number;
  startIndex: number;
  messages: unknown[];
};

export type SessionHistoryWorkerResponse = {
  id: number;
  result: SessionHistoryMessageChunkResult;
};

export interface SessionHistoryWorkerLike {
  onmessage: ((event: MessageEvent<SessionHistoryWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: SessionHistoryWorkerRequest): void;
  terminate(): void;
}

type WorkerFactory = () => SessionHistoryWorkerLike;
type PoolJob = {
  request: Omit<SessionHistoryWorkerRequest, 'id'>;
  signal?: AbortSignal;
  resolve: (result: SessionHistoryMessageChunkResult) => void;
  reject: (reason: unknown) => void;
  abort?: () => void;
};
type WorkerOutcome = { result: SessionHistoryMessageChunkResult } | { error: unknown };

function abortError(): DOMException {
  return new DOMException('Session history validation was aborted.', 'AbortError');
}

function defaultPoolSize(): number {
  const concurrency = typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency || 2;
  return Math.max(1, Math.min(SESSION_HISTORY_MAX_WORKERS, concurrency - 1 || 1));
}

function defaultWorkerFactory(): SessionHistoryWorkerLike {
  return new Worker(new URL('./sessionHistoryValidation.worker.ts', import.meta.url), { type: 'module' });
}

export class SessionHistoryWorkerPool {
  readonly size: number;
  private readonly workerFactory: WorkerFactory;
  private readonly workers: Array<{ worker: SessionHistoryWorkerLike; busy: boolean; job?: PoolJob }> = [];
  private readonly queue: PoolJob[] = [];
  private nextId = 1;
  private unusable = false;

  constructor(workerFactory: WorkerFactory = defaultWorkerFactory, size = defaultPoolSize()) {
    this.workerFactory = workerFactory;
    this.size = Math.max(1, Math.floor(size));
  }

  run(request: Omit<SessionHistoryWorkerRequest, 'id'>, signal?: AbortSignal): Promise<SessionHistoryMessageChunkResult> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.unusable) return Promise.reject(new Error('Session history worker pool is unavailable.'));
    return new Promise((resolve, reject) => {
      const job: PoolJob = { request, signal, resolve, reject };
      if (signal) {
        job.abort = () => {
          const index = this.queue.indexOf(job);
          if (index >= 0) this.queue.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener('abort', job.abort, { once: true });
      }
      this.queue.push(job);
      this.dispatch();
    });
  }

  private dispatch(): void {
    while (this.queue.length > 0) {
      let slot = this.workers.find((entry) => !entry.busy);
      if (!slot && this.workers.length < this.size) {
        try {
          const worker = this.workerFactory();
          slot = { worker, busy: false };
          worker.onmessage = (event) => this.complete(slot!, event.data);
          worker.onerror = (event) => this.breakPool(event.error ?? new Error(event.message || 'Session history worker failed.'));
          this.workers.push(slot);
        } catch (error) {
          this.breakPool(error);
          return;
        }
      }
      if (!slot) return;
      const job = this.queue.shift()!;
      if (job.signal?.aborted) {
        job.reject(abortError());
        continue;
      }
      slot.busy = true;
      slot.job = job;
      try {
        slot.worker.postMessage({ id: this.nextId++, ...job.request });
      } catch (error) {
        this.breakPool(error);
        return;
      }
    }
  }

  private complete(slot: { worker: SessionHistoryWorkerLike; busy: boolean; job?: PoolJob }, response: SessionHistoryWorkerResponse): void {
    const job = slot.job;
    slot.busy = false;
    slot.job = undefined;
    if (job) {
      if (job.abort && job.signal) job.signal.removeEventListener('abort', job.abort);
      if (job.signal?.aborted) job.reject(abortError());
      else job.resolve(response.result);
    }
    this.dispatch();
  }

  private breakPool(reason: unknown): void {
    if (this.unusable) return;
    this.unusable = true;
    for (const slot of this.workers) {
      slot.worker.terminate();
      if (slot.job) slot.job.reject(reason);
    }
    for (const job of this.queue.splice(0)) job.reject(reason);
    this.workers.length = 0;
  }
}

export type SessionHistoryValidationOptions = {
  signal?: AbortSignal;
  pool?: SessionHistoryWorkerPool;
  threshold?: number;
};

let sharedPool: SessionHistoryWorkerPool | undefined;

function getSharedPool(): SessionHistoryWorkerPool {
  sharedPool ??= new SessionHistoryWorkerPool();
  return sharedPool;
}

export async function parseSessionHistoryEnvelopeAsync(
  input: unknown,
  options: SessionHistoryValidationOptions = {},
): Promise<ContractParseResult<SessionHistoryEnvelope>> {
  if (options.signal?.aborted) throw abortError();
  const structure = parseSessionHistoryEnvelopeStructure(input);
  if (!structure.ok) return parseSessionHistoryEnvelope(input);
  const messages = structure.value.data.messages;
  const threshold = options.threshold ?? SESSION_HISTORY_WORKER_THRESHOLD;
  if (messages.length < threshold || typeof Worker === 'undefined' && !options.pool) {
    return parseSessionHistoryEnvelope(input);
  }

  const pool = options.pool ?? getSharedPool();
  const taskCount = Math.min(
    Math.ceil(messages.length / SESSION_HISTORY_MIN_MESSAGES_PER_TASK),
    pool.size * SESSION_HISTORY_TASKS_PER_WORKER,
  );
  const chunkSize = Math.ceil(messages.length / taskCount);
  const chunks = Array.from({ length: taskCount }, (_, taskIndex) => {
    const startIndex = taskIndex * chunkSize;
    return { startIndex, messages: messages.slice(startIndex, Math.min(messages.length, startIndex + chunkSize)) };
  });
  try {
    const outcomes = await Promise.all(chunks.map(async (chunk): Promise<WorkerOutcome> => {
      try {
        return { result: await pool.run(chunk, options.signal) };
      } catch (error) {
        return { error };
      }
    }));
    if (options.signal?.aborted) throw abortError();
    const abort = outcomes.find((outcome) => 'error' in outcome && outcome.error instanceof DOMException && outcome.error.name === 'AbortError');
    if (abort) throw abortError();
    const results = outcomes.map((outcome, index) => 'result' in outcome
      ? outcome.result
      : validateFailedChunk(chunks[index]));
    const failures = results.filter((result): result is ContractParseFailure & { messageIndex: number } => !result.ok);
    if (failures.length > 0) {
      return failures.reduce((lowest, failure) => failure.messageIndex < lowest.messageIndex ? failure : lowest);
    }
    return {
      ok: true,
      value: {
        ...structure.value,
        data: { ...structure.value.data, messages: messages as SessionHistoryEnvelope['data']['messages'] },
      },
    };
  } catch (error) {
    if (options.signal?.aborted || error instanceof DOMException && error.name === 'AbortError') throw abortError();
    return parseSessionHistoryEnvelope(input);
  }
}

function validateFailedChunk(chunk: Omit<SessionHistoryWorkerRequest, 'id'>): SessionHistoryMessageChunkResult {
  return validateSessionHistoryMessageChunk(chunk.messages, chunk.startIndex);
}
