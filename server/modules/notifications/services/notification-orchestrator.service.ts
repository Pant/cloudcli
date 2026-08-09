import webPush from 'web-push';

import { notificationPreferencesDb, pushSubscriptionsDb, sessionsDb } from '@/modules/database/index.js';
import { sendDesktopNotification as sendDesktopNotificationToClients } from '@/modules/notifications/services/desktop-notification-clients.service.js';

type NotificationKind = 'action_required' | 'stop' | 'error' | 'info';
type NotificationMeta = Record<string, unknown> & {
  error?: string;
  message?: unknown;
  sessionName?: unknown;
  stopReason?: string;
  toolName?: string;
  taskId?: string;
  taskSummary?: string | null;
};
type NotificationEvent = {
  provider: string;
  sessionId: string | null;
  kind: NotificationKind;
  code: string;
  meta: NotificationMeta;
  severity: string;
  requiresUserAction: boolean;
  dedupeKey: string | null;
  createdAt: string;
};
type NotificationEventInput = Pick<NotificationEvent, 'provider'> & Partial<Omit<NotificationEvent, 'provider'>>;
type NotificationPayload = {
  title: string;
  body: string;
  data: {
    sessionId: string | null;
    code: string;
    provider: string | null;
    sessionName: string | null;
    severity: string;
    stopReason: string | null;
    replyEligible: boolean;
    tag: string;
    completionType: 'run' | 'task' | null;
    taskId: string | null;
    taskSummary: string | null;
  };
};
type SessionRow = ReturnType<typeof sessionsDb.getSessionById>;

const KIND_TO_PREF_KEY = {
  action_required: 'actionRequired',
  stop: 'stop',
  error: 'error',
} as const;

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  opencode: 'OpenCode',
  system: 'System',
};

const recentEventKeys = new Map<string, number>();
const DEDUPE_WINDOW_MS = 20000;

function normalizeSeverity(severity: unknown): string {
  if (typeof severity !== 'string') return 'info';
  return severity.trim().toLowerCase() || 'info';
}

const cleanupOldEventKeys = (): void => {
  const now = Date.now();
  for (const [key, timestamp] of recentEventKeys.entries()) {
    if (now - timestamp > DEDUPE_WINDOW_MS) recentEventKeys.delete(key);
  }
};

function isNotificationEventEnabled(
  preferences: ReturnType<typeof notificationPreferencesDb.getPreferences>,
  event: NotificationEvent,
): boolean {
  const prefEventKey = KIND_TO_PREF_KEY[event.kind as keyof typeof KIND_TO_PREF_KEY];
  return prefEventKey ? Boolean(preferences?.events?.[prefEventKey]) : true;
}

function isDuplicate(event: NotificationEvent): boolean {
  cleanupOldEventKeys();
  const key = event.dedupeKey || `${event.provider}:${event.kind || 'info'}:${event.code || 'generic'}:${event.sessionId || 'none'}`;
  if (recentEventKeys.has(key)) return true;
  recentEventKeys.set(key, Date.now());
  return false;
}

/** Used by provider runtimes and notification settings to create normalized events. */
export function createNotificationEvent({
  provider,
  sessionId = null,
  kind = 'info',
  code = 'generic.info',
  meta = {},
  severity = 'info',
  dedupeKey = null,
  requiresUserAction = false,
}: {
  provider: string;
  sessionId?: string | null;
  kind?: NotificationKind;
  code?: string;
  meta?: NotificationMeta;
  severity?: string;
  dedupeKey?: string | null;
  requiresUserAction?: boolean;
}): NotificationEvent {
  return { provider, sessionId, kind, code, meta, severity: normalizeSeverity(severity), requiresUserAction, dedupeKey, createdAt: new Date().toISOString() };
}

function normalizeErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  if (error == null) return 'Unknown error';
  return String(error);
}

function normalizeSessionName(sessionName: unknown): string | null {
  if (typeof sessionName !== 'string') return null;
  const normalized = sessionName.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function rowMatchesProvider(row: SessionRow, provider: string): boolean {
  return Boolean(row && (!provider || row.provider === provider));
}

function resolveSessionRow(sessionId: string | null, provider: string): SessionRow {
  if (!sessionId) return null;
  const appSessionRow = sessionsDb.getSessionById(sessionId);
  if (rowMatchesProvider(appSessionRow, provider)) return appSessionRow;
  const providerSessionRow = sessionsDb.getSessionByProviderSessionId(sessionId);
  return rowMatchesProvider(providerSessionRow, provider) ? providerSessionRow : null;
}

function normalizeNotificationSession(event: NotificationEvent): NotificationEvent {
  if (!event.sessionId || !event.provider || event.provider === 'system') return event;
  const row = resolveSessionRow(event.sessionId, event.provider);
  if (!row || row.session_id === event.sessionId) return event;
  return { ...event, sessionId: row.session_id };
}

function resolveSessionName(event: NotificationEvent): string | null {
  const explicitSessionName = normalizeSessionName(event.meta.sessionName);
  if (explicitSessionName) return explicitSessionName;
  if (!event.sessionId || !event.provider) return null;
  return normalizeSessionName(sessionsDb.getSessionName(event.sessionId, event.provider));
}

/** Used by notification delivery workflows and tests to construct channel payloads. */
export function buildNotificationPayload(event: NotificationEventInput): NotificationPayload {
  const normalizedEvent = normalizeNotificationSession(createNotificationEvent(event));
  const codeMap: Record<string, string> = {
    'permission.required': normalizedEvent.meta.toolName
      ? `Action Required: Tool "${normalizedEvent.meta.toolName}" needs approval`
      : 'Action Required: A tool needs your approval',
    'run.stopped': normalizedEvent.meta.stopReason || 'Run Stopped: The run has stopped',
    'task.completed': normalizedEvent.meta.taskSummary ? `Task Completed: ${normalizedEvent.meta.taskSummary}` : 'Task Completed',
    'run.failed': normalizedEvent.meta.error ? `Run Failed: ${normalizedEvent.meta.error}` : 'Run Failed: The run encountered an error',
    'agent.notification': normalizedEvent.meta.message ? String(normalizedEvent.meta.message) : 'You have a new notification',
    'push.enabled': 'Push notifications are now enabled!',
  };
  const providerLabel = PROVIDER_LABELS[normalizedEvent.provider] || 'Assistant';
  const sessionName = resolveSessionName(normalizedEvent);
  const stopReason = normalizedEvent.code === 'run.stopped' ? normalizedEvent.meta.stopReason || null : null;
  const completionType = normalizedEvent.code === 'run.stopped'
    ? 'run'
    : normalizedEvent.code === 'task.completed' ? 'task' : null;

  return {
    title: sessionName || 'CloudCLI',
    body: `${providerLabel}: ${codeMap[normalizedEvent.code] || 'You have a new notification'}`,
    data: {
      sessionId: normalizedEvent.sessionId || null,
      code: normalizedEvent.code,
      provider: normalizedEvent.provider || null,
      sessionName,
      severity: normalizedEvent.severity,
      stopReason,
      replyEligible: stopReason === 'completed',
      tag: `${normalizedEvent.provider || 'assistant'}:${normalizedEvent.sessionId || 'none'}:${normalizedEvent.code}`,
      completionType,
      taskId: typeof normalizedEvent.meta.taskId === 'string' ? normalizedEvent.meta.taskId : null,
      taskSummary: normalizeSessionName(normalizedEvent.meta.taskSummary),
    },
  };
}

type WebPushSender = typeof webPush.sendNotification;
let webPushSender: WebPushSender = webPush.sendNotification.bind(webPush);

/** Notification integration tests replace the network sender while retaining persisted-subscription dispatch. */
export function setNotificationWebPushSenderForTests(sender: WebPushSender | null): void {
  webPushSender = sender ?? webPush.sendNotification.bind(webPush);
}

function sendWebPushPayload(userId: number, payload: NotificationPayload): Promise<unknown> {
  const subscriptions = pushSubscriptionsDb.getSubscriptions(userId);
  if (!subscriptions.length) return Promise.resolve();
  return Promise.allSettled(subscriptions.map((sub) => webPushSender({
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth },
  }, JSON.stringify(payload)))).then((results) => {
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const statusCode = (result.reason as { statusCode?: number } | undefined)?.statusCode;
        if (statusCode === 410 || statusCode === 404) pushSubscriptionsDb.removeSubscription(subscriptions[index].endpoint);
      }
    });
  });
}

const notificationChannels = [
  { id: 'webPush', isEnabled: (preferences: ReturnType<typeof notificationPreferencesDb.getPreferences>) => Boolean(preferences.channels.webPush), send: ({ userId, payload }: { userId: number; payload: NotificationPayload }) => sendWebPushPayload(userId, payload) },
  { id: 'desktop', isEnabled: (preferences: ReturnType<typeof notificationPreferencesDb.getPreferences>) => Boolean(preferences.channels.desktop), send: ({ userId, payload }: { userId: number; payload: NotificationPayload }) => sendDesktopNotificationToClients(userId, payload) },
];

/** Used by provider runtimes and settings to deliver events through enabled channels. */
export function notifyUserIfEnabled({ userId, event }: { userId: string | number | null; event: unknown }): void {
  const normalizedUserId = Number(userId);
  if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0 || !event || typeof event !== 'object' || !('provider' in event)) return;
  const normalizedEvent = normalizeNotificationSession(event as NotificationEvent);
  const preferences = notificationPreferencesDb.getPreferences(normalizedUserId);
  if (!isNotificationEventEnabled(preferences, normalizedEvent) || isDuplicate(normalizedEvent)) return;
  const payload = buildNotificationPayload(normalizedEvent);
  for (const channel of notificationChannels) {
    if (!channel.isEnabled(preferences)) continue;
    Promise.resolve(channel.send({ userId: normalizedUserId, payload })).catch((err: unknown) => {
      console.error(`Notification channel "${channel.id}" send error:`, err);
    });
  }
}

/** Used by provider runtimes to report stopped or completed agent runs. */
export function notifyRunStopped({ userId, provider, sessionId = null, stopReason = 'completed', sessionName = null }: { userId: string | number | null; provider: string; sessionId?: string | null; stopReason?: string; sessionName?: string | null }): void {
  notifyUserIfEnabled({ userId, event: createNotificationEvent({ provider, sessionId, kind: 'stop', code: 'run.stopped', meta: { stopReason, sessionName }, severity: 'info', dedupeKey: `${provider}:run:stop:${sessionId || 'none'}:${stopReason}` }) });
}

/** The OpenCode runtime uses this to report one successfully completed Task tool call. */
export function notifyTaskCompleted({ userId, sessionId, taskId, taskSummary = null, sessionName = null }: { userId: string | number | null; sessionId: string; taskId: string; taskSummary?: string | null; sessionName?: string | null }): void {
  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider: 'opencode', sessionId, kind: 'stop', code: 'task.completed',
      meta: { taskId, taskSummary, sessionName }, severity: 'info',
      dedupeKey: `opencode:task:completed:${sessionId}:${taskId}`,
    }),
  });
}

/** Used by provider runtimes to report failed agent runs. */
export function notifyRunFailed({ userId, provider, sessionId = null, error, sessionName = null }: { userId: string | number | null; provider: string; sessionId?: string | null; error: unknown; sessionName?: string | null }): void {
  const errorMessage = normalizeErrorMessage(error);
  notifyUserIfEnabled({ userId, event: createNotificationEvent({ provider, sessionId, kind: 'error', code: 'run.failed', meta: { error: errorMessage, sessionName }, severity: 'error', dedupeKey: `${provider}:run:error:${sessionId || 'none'}:${errorMessage}` }) });
}
