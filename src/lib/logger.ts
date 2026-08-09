import { version } from '../../package.json';

export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';
export type DiagnosticMetric =
  | 'websocketReconnect'
  | 'replayGap'
  | 'restRecovery'
  | 'contractValidationFailure'
  | 'staleResponseRejection'
  | 'cacheFailure'
  | 'hydrationDuration'
  | 'duplicateEventRejection'
  | 'mutationConflict';

export type DiagnosticEvent = {
  timestamp: string;
  level: DiagnosticLevel;
  area: string;
  event: string;
  requestId?: string;
  sessionId?: string;
  projectId?: string;
  connectionEpoch?: number;
  generation?: number;
  seq?: number;
  canonicalRevision?: string;
  cacheRevision?: string;
  durationMs?: number;
  outcome?: string;
  code?: string;
  metadata?: Record<string, unknown>;
};

type DiagnosticInput = Omit<DiagnosticEvent, 'timestamp'> & { timestamp?: string };

const MAX_EVENTS = 750;
const MAX_STRING_LENGTH = 500;
const MAX_OBJECT_KEYS = 30;
const MAX_ARRAY_ITEMS = 30;
const MAX_DEPTH = 4;
const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /token|authorization|cookie|password|secret|credential|api.?key|prompt|content|files?|file.?contents?|body|path/i;
const BEARER_OR_JWT = /(?:bearer\s+[a-z0-9._~+\/-]+=*|eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)/gi;

const events: DiagnosticEvent[] = [];
const metrics: Record<DiagnosticMetric, number> = {
  websocketReconnect: 0,
  replayGap: 0,
  restRecovery: 0,
  contractValidationFailure: 0,
  staleResponseRejection: 0,
  cacheFailure: 0,
  hydrationDuration: 0,
  duplicateEventRejection: 0,
  mutationConflict: 0,
};

function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return value.replace(BEARER_OR_JWT, REDACTED).slice(0, MAX_STRING_LENGTH);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (value === undefined) return undefined;
  if (value instanceof Error) return { name: value.name, message: sanitize(value.message) };
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (typeof value !== 'object') return String(value).slice(0, MAX_STRING_LENGTH);
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, depth + 1, seen));
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    result[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitize(child, depth + 1, seen);
  }
  return result;
}

export function logDiagnostic(input: DiagnosticInput): void {
  try {
    const sanitized = sanitize(input) as DiagnosticInput;
    const entry: DiagnosticEvent = {
      ...sanitized,
      timestamp: typeof sanitized.timestamp === 'string' ? sanitized.timestamp : new Date().toISOString(),
    };
    events.push(entry);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  } catch {
    // Diagnostics must never affect application behavior.
  }
}

export function incrementDiagnosticMetric(metric: DiagnosticMetric, amount = 1): void {
  try { metrics[metric] = Math.max(0, metrics[metric] + (Number.isFinite(amount) ? amount : 0)); } catch { /* no-op */ }
}

export function readDiagnosticMetrics(): Readonly<Record<DiagnosticMetric, number>> {
  return { ...metrics };
}

export function exportDiagnostics(): string {
  try {
    return JSON.stringify({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      app: { name: 'CloudCLI', version, build: (import.meta as ImportMeta & { env?: { MODE?: string } }).env?.MODE ?? 'unknown' },
      metrics: readDiagnosticMetrics(),
      events: events.map((event) => sanitize(event)),
    }, null, 2);
  } catch {
    return JSON.stringify({ schemaVersion: 1, error: 'Diagnostics export unavailable.' });
  }
}

export function clearDiagnostics(): void {
  events.length = 0;
  for (const metric of Object.keys(metrics) as DiagnosticMetric[]) metrics[metric] = 0;
}

export const diagnosticLimits = { maxEvents: MAX_EVENTS, maxStringLength: MAX_STRING_LENGTH } as const;
