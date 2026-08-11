import { useEffect, useRef } from 'react';

import { clearQueuedMessage, readQueuedMessage } from '../components/chat/utils/chatStorage';

import type { MarkSessionProcessing, SessionActivityMap } from './useSessionProtection';

interface UseQueuedMessageAutoSendArgs {
  processingSessions: SessionActivityMap;
  /**
   * The session currently open in the chat view. Its queued draft is owned by
   * the composer (which also handles file attachments and slash commands),
   * so this hook never touches it.
   */
  activeSessionId: string | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => boolean;
  markSessionProcessing: MarkSessionProcessing;
}

export interface QueuedMessageAutoSendState {
  previousProcessing: ReadonlySet<string>;
  readyToSend: Set<string>;
  accepted: Set<string>;
}

export function flushQueuedMessageAutoSend({
  state,
  processingSessions,
  activeSessionId,
  socketOpen,
  sendMessage,
  markSessionProcessing,
}: Omit<UseQueuedMessageAutoSendArgs, 'ws'> & {
  state: QueuedMessageAutoSendState;
  socketOpen: boolean;
}) {
  const current = new Set(processingSessions.keys());
  for (const sessionId of current) state.accepted.delete(sessionId);
  for (const sessionId of state.previousProcessing) {
    if (!current.has(sessionId) && sessionId !== activeSessionId) state.readyToSend.add(sessionId);
  }
  state.previousProcessing = current;

  for (const sessionId of state.readyToSend) {
    if (current.has(sessionId) || sessionId === activeSessionId || state.accepted.has(sessionId)) continue;
    const queued = readQueuedMessage(sessionId);
    if (!queued) {
      state.readyToSend.delete(sessionId);
      continue;
    }
    if (!socketOpen) continue;
    const accepted = sendMessage({
      type: 'chat.send',
      sessionId,
      content: queued.content,
      options: { ...(queued.options ?? {}), attachments: queued.attachments ?? queued.images ?? [] },
    });
    if (!accepted) continue;
    state.accepted.add(sessionId);
    state.readyToSend.delete(sessionId);
    clearQueuedMessage(sessionId);
    markSessionProcessing(sessionId, { statusText: null, canInterrupt: true });
  }
}

/**
 * Dispatches queued messages for sessions the user is NOT currently viewing.
 *
 * The composer persists each queued draft (text + send options snapshotted at
 * queue time) under `queued_message_<sessionId>`. When a session's run leaves
 * the processing map — its previous response completed — this hook sends that
 * session's queued message immediately instead of waiting for the user to
 * open the session again. Removing the storage key before sending is the
 * claim that keeps the composer's own flush from double-sending.
 */
export function useQueuedMessageAutoSend({
  processingSessions,
  activeSessionId,
  ws,
  sendMessage,
  markSessionProcessing,
}: UseQueuedMessageAutoSendArgs) {
  const stateRef = useRef<QueuedMessageAutoSendState>({
    previousProcessing: new Set(),
    readyToSend: new Set(),
    accepted: new Set(),
  });

  useEffect(() => {
    flushQueuedMessageAutoSend({
      state: stateRef.current,
      processingSessions,
      activeSessionId,
      socketOpen: Boolean(ws && ws.readyState === WebSocket.OPEN),
      sendMessage,
      markSessionProcessing,
    });
  }, [processingSessions, activeSessionId, ws, sendMessage, markSessionProcessing]);
}
