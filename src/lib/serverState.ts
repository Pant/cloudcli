import { logDiagnostic } from './logger';

export type ServerStateStatus = 'idle' | 'loading' | 'success' | 'error';

export type ServerStateSnapshot<T> = Readonly<{
  value: T | undefined;
  error: unknown;
  status: ServerStateStatus;
  fetchedAt: number;
  invalidated: boolean;
}>;

export type ServerStateReadOptions = {
  force?: boolean;
  staleTime?: number;
};

type Entry<T> = {
  snapshot: ServerStateSnapshot<T>;
  request: Promise<T> | null;
  controller: AbortController | null;
  generation: number;
  listeners: Set<() => void>;
};

const initialSnapshot = <T>(): ServerStateSnapshot<T> => ({
  value: undefined,
  error: null,
  status: 'idle',
  fetchedAt: 0,
  invalidated: false,
});

const isAbortError = (error: unknown) => error instanceof DOMException
  ? error.name === 'AbortError'
  : error instanceof Error && error.name === 'AbortError';

export class KeyedServerState<K, T> {
  private readonly entries = new Map<K, Entry<T>>();
  private disposed = false;

  constructor(
    private readonly fetcher: (key: K, signal: AbortSignal) => Promise<T>,
    private readonly defaultStaleTime = 0,
    private readonly now: () => number = Date.now,
  ) {}

  private entry(key: K): Entry<T> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { snapshot: initialSnapshot(), request: null, controller: null, generation: 0, listeners: new Set() };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private publish(entry: Entry<T>, snapshot: ServerStateSnapshot<T>): void {
    if (this.disposed) return;
    entry.snapshot = snapshot;
    for (const listener of [...entry.listeners]) {
      try { listener(); } catch { /* subscribers cannot break ownership */ }
    }
  }

  getSnapshot = (key: K): ServerStateSnapshot<T> => this.entry(key).snapshot;

  subscribe = (key: K, listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    const entry = this.entry(key);
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  };

  read(key: K, options: ServerStateReadOptions = {}): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Server state owner is disposed.'));
    const entry = this.entry(key);
    const staleTime = options.staleTime ?? this.defaultStaleTime;
    const fresh = entry.snapshot.value !== undefined
      && !entry.snapshot.invalidated
      && this.now() - entry.snapshot.fetchedAt <= staleTime;
    if (!options.force && fresh) return Promise.resolve(entry.snapshot.value as T);
    if (!options.force && entry.request) return entry.request;

    if (options.force && entry.controller) entry.controller.abort();
    const generation = ++entry.generation;
    const controller = new AbortController();
    entry.controller = controller;
    this.publish(entry, { ...entry.snapshot, status: 'loading', error: null });

    const request = this.fetcher(key, controller.signal).then((value) => {
      if (!this.disposed && generation === entry.generation && !controller.signal.aborted) {
        this.publish(entry, { value, error: null, status: 'success', fetchedAt: this.now(), invalidated: false });
      }
      return value;
    }).catch((error: unknown) => {
      if (!this.disposed && generation === entry.generation && !isAbortError(error) && !controller.signal.aborted) {
        this.publish(entry, { ...entry.snapshot, error, status: 'error' });
        logDiagnostic({ level: 'warn', area: 'server_state', event: 'request_failed', outcome: 'error', metadata: { key: String(key), error } });
      }
      throw error;
    }).finally(() => {
      if (generation === entry.generation) {
        entry.request = null;
        entry.controller = null;
      }
    });
    entry.request = request;
    return request;
  }

  invalidate(key: K): void {
    const entry = this.entry(key);
    this.publish(entry, { ...entry.snapshot, invalidated: true });
  }

  patch(key: K, update: T | ((current: T | undefined) => T)): T {
    const entry = this.entry(key);
    const value = typeof update === 'function'
      ? (update as (current: T | undefined) => T)(entry.snapshot.value)
      : update;
    this.publish(entry, { value, error: null, status: 'success', fetchedAt: this.now(), invalidated: false });
    return value;
  }

  cancel(key: K): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.generation += 1;
    entry.controller?.abort();
    entry.controller = null;
    entry.request = null;
    if (entry.snapshot.status === 'loading') this.publish(entry, { ...entry.snapshot, status: entry.snapshot.value === undefined ? 'idle' : 'success' });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) {
      entry.generation += 1;
      entry.controller?.abort();
      entry.listeners.clear();
    }
    this.entries.clear();
  }
}
