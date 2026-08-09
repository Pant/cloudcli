import {
  parseApiErrorEnvelope,
  parseApiSuccessEnvelope,
  parseRunningSessionSnapshot,
  parseSessionRenameMutationResult,
  parseSessionStartMutationResult,
  parseSessionLifecycleSnapshot,
  type ContractParseResult,
  type RunningSessionSnapshot,
  type SessionHistoryPayload,
  type SessionLifecycleSnapshot,
  type SessionRenameMutationResult,
  type SessionStartMutationResult,
} from '../../shared/cloudcli-contracts';
import { IS_PLATFORM } from '../constants/config';
import { incrementDiagnosticMetric, logDiagnostic } from '../lib/logger';

import { expireAuthSession, getStoredAuthToken, storeAuthToken } from './authToken';
import { parseSessionHistoryEnvelopeAsync, type SessionHistoryValidationOptions } from './sessionHistoryValidation';

export type ApiErrorCode = 'ABORTED' | 'TIMEOUT' | 'NETWORK_ERROR' | 'CONTRACT_ERROR' | 'HTTP_ERROR' | string;

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly requestId: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
  readonly details?: unknown;

  constructor(options: { status?: number; code: ApiErrorCode; message: string; requestId: string; retryable?: boolean; cause?: unknown; details?: unknown }) {
    super(options.message);
    this.name = 'ApiError';
    this.status = options.status ?? 0;
    this.code = options.code;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause;
    this.details = options.details;
  }
}

export type RequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  requestId?: string;
  idempotencyKey?: string;
  retry?: boolean;
};

export type SessionHistoryResult =
  | { notModified: true; revision: string }
  | { notModified: false; data: SessionHistoryPayload; revision: string };

type RequestEngineOptions = RequestOptions & {
  method?: string;
  body?: unknown;
  headers?: HeadersInit;
  cache?: RequestCache;
};

type SyncJsonParser<T> = (input: unknown) => ContractParseResult<T>;
type JsonParser<T> = (input: unknown) => ContractParseResult<T> | Promise<ContractParseResult<T>>;
type HistoryParser = (input: unknown, options?: SessionHistoryValidationOptions) => ReturnType<typeof parseSessionHistoryEnvelopeAsync>;

const DEFAULT_TIMEOUT_MS = 15_000;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const getRequestId = () => globalThis.crypto?.randomUUID?.() ?? `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
// Browser fetch requires the Window receiver. Keep the native call behind a
// wrapper so invoking the injected transport as an ApiClient method is safe.
const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

const retryDelay = () => new Promise((resolve) => setTimeout(resolve, 0));

function normalizeDiagnosticRoute(url: string): string {
  return url.split('?')[0].replace(/\/sessions\/[^/]+/g, '/sessions/:sessionId');
}

function parseArrayPayload<T>(key: string, itemParser: SyncJsonParser<T>): SyncJsonParser<{ sessions: T[] }> {
  return (input) => {
    if (!input || typeof input !== 'object' || !Array.isArray((input as Record<string, unknown>)[key])) {
      return { ok: false, error: { code: 'INVALID_FIELD', path: `$.data.${key}`, message: `$.data.${key} must be an array.` } };
    }
    const values: T[] = [];
    for (const item of (input as Record<string, unknown>)[key] as unknown[]) {
      const parsed = itemParser(item);
      if (!parsed.ok) return parsed;
      values.push(parsed.value);
    }
    return { ok: true, value: { sessions: values } };
  };
}

const parseUnknownObject: SyncJsonParser<Record<string, unknown>> = (input) => input !== null && typeof input === 'object' && !Array.isArray(input)
  ? { ok: true, value: input as Record<string, unknown> }
  : { ok: false, error: { code: 'INVALID_TYPE', path: '$.data', message: '$.data must be an object.' } };

export class ApiClient {
  constructor(
    private readonly fetchImpl: typeof fetch = defaultFetch,
    private readonly historyParser: HistoryParser = parseSessionHistoryEnvelopeAsync,
  ) {}

  private async request<T>(url: string, parser: JsonParser<T>, options: RequestEngineOptions = {}): Promise<T> {
    const method = (options.method ?? 'GET').toUpperCase();
    const safeRead = method === 'GET' || method === 'HEAD';
    // Deterministic policy: safe reads retry once for transport failures and
    // transient HTTP statuses. Contract failures and ordinary 4xx never retry.
    const maxAttempts = safeRead && options.retry !== false ? 2 : 1;
    const requestId = options.requestId ?? getRequestId();
    const route = normalizeDiagnosticRoute(url);
    const startedAt = Date.now();
    logDiagnostic({ level: 'info', area: 'api', event: 'request_started', requestId, metadata: { method, route } });

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const timeoutController = new AbortController();
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; timeoutController.abort(); }, timeoutMs);
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeoutController.signal])
        : timeoutController.signal;
      try {
        const headers = new Headers(options.headers);
        headers.set('X-Request-ID', requestId);
        if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
        if (options.body !== undefined && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
        const token = getStoredAuthToken();
        if (!IS_PLATFORM && token) headers.set('Authorization', `Bearer ${token}`);
        const response = await this.fetchImpl(url, {
          method,
          headers,
          signal,
          cache: options.cache,
          ...(options.body !== undefined ? { body: options.body instanceof FormData ? options.body : JSON.stringify(options.body) } : {}),
        });
        const serverRequestId = response.headers.get('X-Request-ID') ?? response.headers.get('X-Request-Id') ?? requestId;
        const refreshedToken = response.headers.get('X-Refreshed-Token');
        if (refreshedToken) storeAuthToken(refreshedToken);
        if (response.headers.get('X-Auth-Error')) expireAuthSession();

        let json: unknown;
        try { json = await response.json(); } catch (cause) {
          throw new ApiError({ status: response.status, code: 'CONTRACT_ERROR', message: 'API response was not valid JSON.', requestId: serverRequestId, cause });
        }
        if (!response.ok) {
          const parsedError = parseApiErrorEnvelope(json);
          const retryable = parsedError.ok ? Boolean(parsedError.value.error.retryable) : RETRYABLE_STATUSES.has(response.status);
          const error = new ApiError({
            status: response.status,
            code: parsedError.ok ? parsedError.value.error.code : 'HTTP_ERROR',
            message: parsedError.ok ? parsedError.value.error.message : `Request failed with HTTP ${response.status}.`,
            requestId: parsedError.ok ? parsedError.value.requestId ?? serverRequestId : serverRequestId,
            retryable,
            details: parsedError.ok ? parsedError.value.error.details : undefined,
          });
          if (attempt < maxAttempts && RETRYABLE_STATUSES.has(response.status)) {
            logDiagnostic({ level: 'warn', area: 'api', event: 'request_retried', requestId, durationMs: Date.now() - startedAt, code: error.code, metadata: { method, route, status: response.status, attempt, retryable: true } });
            await retryDelay(); continue;
          }
          throw error;
        }
        const parsed = await parser(json);
        if (!parsed.ok) {
          throw new ApiError({ status: response.status, code: 'CONTRACT_ERROR', message: parsed.error.message, requestId: serverRequestId });
        }
        logDiagnostic({ level: 'info', area: 'api', event: 'request_succeeded', requestId: serverRequestId, durationMs: Date.now() - startedAt, outcome: 'success', metadata: { method, route, status: response.status, attempt } });
        return parsed.value;
      } catch (cause) {
        let error: ApiError;
        if (cause instanceof ApiError) error = cause;
        else if (options.signal?.aborted) error = new ApiError({ code: 'ABORTED', message: 'Request was aborted by the caller.', requestId, cause });
        else if (timedOut) error = new ApiError({ code: 'TIMEOUT', message: `Request timed out after ${timeoutMs}ms.`, requestId, retryable: true, cause });
        else error = new ApiError({ code: 'NETWORK_ERROR', message: 'Network request failed.', requestId, retryable: true, cause });
        if (error.code === 'CONTRACT_ERROR') incrementDiagnosticMetric('contractValidationFailure');
        if (error.code === 'SESSION_REVISION_CONFLICT') incrementDiagnosticMetric('mutationConflict');
        if (!(cause instanceof ApiError) && error.retryable && attempt < maxAttempts) {
          logDiagnostic({ level: 'warn', area: 'api', event: 'request_retried', requestId, durationMs: Date.now() - startedAt, code: error.code, metadata: { method, route, attempt, retryable: true } });
          await retryDelay(); continue;
        }
        logDiagnostic({ level: 'error', area: 'api', event: 'request_failed', requestId: error.requestId, durationMs: Date.now() - startedAt, outcome: 'failure', code: error.code, metadata: { method, route, status: error.status, attempt, retryable: error.retryable } });
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new ApiError({ code: 'NETWORK_ERROR', message: 'Network request failed.', requestId, retryable: true });
  }

  private async conditionalHistoryRequest(url: string, options: RequestOptions & { revision?: string }): Promise<SessionHistoryResult> {
    const headers = new Headers();
    if (options.revision) headers.set('If-None-Match', `"${options.revision.replaceAll('"', '')}"`);
    const requestId = options.requestId ?? getRequestId();
    const startedAt = Date.now();
    const route = normalizeDiagnosticRoute(url);
    logDiagnostic({ level: 'info', area: 'api', event: 'request_started', requestId, canonicalRevision: options.revision, metadata: { method: 'GET', route, conditional: true } });
    headers.set('X-Request-ID', requestId);
    const token = getStoredAuthToken();
    if (!IS_PLATFORM && token) headers.set('Authorization', `Bearer ${token}`);
    // IndexedDB plus the explicit revision header below are the history cache.
    // Bypass the browser HTTP cache so an unconditional recovery request really
    // receives a full canonical body instead of an implicit cached 304 cycle.
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers, signal: options.signal, cache: 'no-store' });
    } catch (cause) {
      if (options.signal?.aborted) throw new ApiError({ code: 'ABORTED', message: 'Request was aborted by the caller.', requestId, cause });
      throw cause;
    }
    const refreshedToken = response.headers.get('X-Refreshed-Token');
    if (refreshedToken) storeAuthToken(refreshedToken);
    if (response.headers.get('X-Auth-Error')) expireAuthSession();
    const etag = response.headers.get('ETag')?.trim().replace(/^W\//, '').replace(/^"|"$/g, '') ?? options.revision ?? '';
    if (response.status === 304) {
      logDiagnostic({ level: 'info', area: 'api', event: 'request_succeeded', requestId, canonicalRevision: etag, durationMs: Date.now() - startedAt, outcome: 'not_modified', metadata: { method: 'GET', route, status: 304 } });
      return { notModified: true, revision: etag };
    }
    let json: unknown;
    try { json = await response.json(); } catch (cause) { throw new ApiError({ status: response.status, code: 'CONTRACT_ERROR', message: 'API response was not valid JSON.', requestId, cause }); }
    if (!response.ok) throw new ApiError({ status: response.status, code: 'HTTP_ERROR', message: `Request failed with HTTP ${response.status}.`, requestId });
    let parsed: Awaited<ReturnType<HistoryParser>>;
    try {
      parsed = await this.historyParser(json, { signal: options.signal });
    } catch (cause) {
      if (options.signal?.aborted) throw new ApiError({ code: 'ABORTED', message: 'Request was aborted by the caller.', requestId, cause });
      throw cause;
    }
    if (!parsed.ok) throw new ApiError({ status: response.status, code: 'CONTRACT_ERROR', message: parsed.error.message, requestId });
    logDiagnostic({ level: 'info', area: 'api', event: 'request_succeeded', requestId, canonicalRevision: parsed.value.data.revision, durationMs: Date.now() - startedAt, outcome: 'success', metadata: { method: 'GET', route, status: response.status } });
    return { notModified: false, data: parsed.value.data, revision: parsed.value.data.revision };
  }

  async sessionHistory(sessionId: string, options: RequestOptions & { limit?: number | null; offset?: number; revision?: string } = {}): Promise<SessionHistoryResult> {
    const params = new URLSearchParams();
    if (options.limit !== null && options.limit !== undefined) { params.set('limit', String(options.limit)); params.set('offset', String(options.offset ?? 0)); }
    const query = params.toString();
    const url = `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages${query ? `?${query}` : ''}`;
    if (options.revision) return this.conditionalHistoryRequest(url, options);
    const envelope = await this.request(url, (input) => this.historyParser(input, { signal: options.signal }), { ...options, cache: 'no-store' });
    return { notModified: false, data: envelope.data, revision: envelope.data.revision };
  }

  async runningSessions(options: RequestOptions = {}): Promise<RunningSessionSnapshot[]> {
    const envelope = await this.request('/api/providers/sessions/running', (input) => parseApiSuccessEnvelope(input, parseArrayPayload('sessions', parseRunningSessionSnapshot)), options);
    return envelope.data.sessions;
  }

  async sessionLifecycleStatus(options: RequestOptions = {}): Promise<SessionLifecycleSnapshot[]> {
    const envelope = await this.request('/api/providers/sessions/status', (input) => parseApiSuccessEnvelope(input, parseArrayPayload('sessions', parseSessionLifecycleSnapshot)), options);
    return envelope.data.sessions;
  }

  async startSession(sessionId: string, metadata: { clientMutationId?: string } = {}, options: RequestOptions = {}): Promise<SessionStartMutationResult> {
    const envelope = await this.request(`/api/providers/sessions/${encodeURIComponent(sessionId)}/start`, (input) => parseApiSuccessEnvelope(input, parseSessionStartMutationResult), { ...options, method: 'POST', body: metadata });
    return envelope.data;
  }

  async renameSession(sessionId: string, summary: string, metadata: { clientMutationId?: string; expectedRevision?: string } = {}, options: RequestOptions = {}): Promise<SessionRenameMutationResult> {
    const envelope = await this.request(`/api/providers/sessions/${encodeURIComponent(sessionId)}`, (input) => parseApiSuccessEnvelope(input, parseSessionRenameMutationResult), { ...options, method: 'PUT', body: { summary, ...metadata } });
    return envelope.data;
  }

  async deleteSession(sessionId: string, hardDelete = false, options: RequestOptions = {}): Promise<Record<string, unknown>> {
    const query = hardDelete ? '?force=true' : '';
    const envelope = await this.request(`/api/providers/sessions/${encodeURIComponent(sessionId)}${query}`, (input) => parseApiSuccessEnvelope(input, parseUnknownObject), { ...options, method: 'DELETE' });
    return envelope.data;
  }
}

export const apiClient = new ApiClient();
