import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '../components/auth/context/authContextContract';
import { IS_PLATFORM } from '../constants/config';
import { incrementDiagnosticMetric, logDiagnostic } from '../lib/logger';
import { expireAuthSession, isAuthTokenExpired } from '../utils/api';
import { useReloadSafety } from './ReloadSafetyContext';

import {
  getWebSocketRetryDelay,
  getWebSocketTransportState,
  getClientBuildVersionUrl,
  isCurrentWebSocketLifecycle,
  shouldArmWebSocketReload,
  shouldReloadForClientBuild,
  parseClientBuildResource,
  shouldRetryWebSocketClose,
} from './webSocketTransport';
import WebSocketContext from './webSocketContextValue';
import type {
  ServerEvent,
  ServerEventGuard,
  ServerEventListener,
  SubscribeToServerEvents,
  WebSocketContextType,
} from './webSocketTypes';

/**
 * One frame received from the chat websocket. The server guarantees every
 * frame carries a `kind` (provider message kinds plus gateway kinds such as
 * `chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`). The synthetic `websocket_reconnected` kind is injected
 * client-side when the socket re-opens after a drop.
 */

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws`; // Platform mode: Use same domain as the page (goes through proxy)
  if (!token) return null;
  if (isAuthTokenExpired(token)) {
    expireAuthSession();
    return null;
  }
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`; // OSS mode: Use same host:port that served the page
};

const WEBSOCKET_RELOAD_GRACE_MS = 8_000;
const WEBSOCKET_RELOAD_READINESS_MS = 10_000;
const WEBSOCKET_RELOAD_POLL_MS = 1_000;
const WEBSOCKET_RELOAD_FETCH_TIMEOUT_MS = 1_500;
const WEBSOCKET_RELOAD_SESSION_KEY = 'cloudcli:websocket-reload-consumed';
const CLIENT_BUILD_POLL_MS = 30_000;
const CLIENT_BUILD_FETCH_TIMEOUT_MS = 5_000;

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const lifecycleRef = useRef(0);
  const connectionEpochRef = useRef(0);
  const hasConnectedRef = useRef(false);
  const replayingSessionsRef = useRef(new Set<string>());
  /**
   * Listener registry for the subscribe API. A ref (not state) because the
   * set must be readable synchronously inside `onmessage` and never trigger
   * re-renders of the provider tree.
   */
  const listenersRef = useRef(new Set<ServerEventListener>());
  const [isConnected, setIsConnected] = useState(false);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [replayingSubscriptions, setReplayingSubscriptions] = useState(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { isLoading: isAuthLoading, token, user } = useAuth();
  const { confirmReload } = useReloadSafety();

  const dispatch = useCallback((event: ServerEvent) => {
    if (event.kind === 'chat_subscribed' && typeof event.sessionId === 'string') {
      replayingSessionsRef.current.delete(event.sessionId);
      setReplayingSubscriptions(replayingSessionsRef.current.size);
    }
    if (event.kind === 'chat_subscribed') {
      logDiagnostic({ level: 'info', area: 'websocket', event: 'replay_subscribed', sessionId: event.sessionId, connectionEpoch: connectionEpochRef.current, canonicalRevision: typeof event.historyRevision === 'string' ? event.historyRevision : undefined, generation: typeof event.generation === 'number' ? event.generation : undefined, seq: typeof event.lastSeq === 'number' ? event.lastSeq : undefined, outcome: event.replayGap ? 'gap' : 'synchronized' });
      if (event.replayGap) incrementDiagnosticMetric('replayGap');
    }
    for (const listener of listenersRef.current) {
      try {
        listener(event);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    }
  }, []);

  useEffect(() => {
    const lifecycle = lifecycleRef.current + 1;
    lifecycleRef.current = lifecycle;
    let intentionalClose = false;
    let retryAttempt = 0;
    let reloadTimeout: ReturnType<typeof setTimeout> | null = null;
    let reloadAbortController: AbortController | null = null;
    const canConnect = IS_PLATFORM || (!isAuthLoading && Boolean(user));

    const reloadWasConsumed = () => {
      try {
        return window.sessionStorage.getItem(WEBSOCKET_RELOAD_SESSION_KEY) === 'true';
      } catch {
        return true;
      }
    };

    const clearReload = () => {
      if (reloadTimeout !== null) {
        clearTimeout(reloadTimeout);
        reloadTimeout = null;
      }
      reloadAbortController?.abort();
      reloadAbortController = null;
    };

    const reloadPage = () => {
      clearReload();
      try {
        window.sessionStorage.setItem(WEBSOCKET_RELOAD_SESSION_KEY, 'true');
      } catch {
        // Reload is armed only when storage access proved available.
      }
      if (confirmReload('CloudCLI reconnected after a server restart. Reload now?')) window.location.reload();
    };

    const pollReadinessAndReload = (deadline: number) => {
      if (!isCurrentWebSocketLifecycle(lifecycleRef.current, lifecycle) || intentionalClose) return;
      if (Date.now() >= deadline) {
        reloadPage();
        return;
      }

      const controller = new AbortController();
      reloadAbortController = controller;
      const fetchTimeout = setTimeout(() => controller.abort(), WEBSOCKET_RELOAD_FETCH_TIMEOUT_MS);
      void fetch('/health', { signal: controller.signal })
        .then((response) => {
          if (response.ok) reloadPage();
        })
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(fetchTimeout);
          if (reloadAbortController === controller) reloadAbortController = null;
          if (!isCurrentWebSocketLifecycle(lifecycleRef.current, lifecycle) || intentionalClose || reloadTimeout === null) return;
          reloadTimeout = setTimeout(() => pollReadinessAndReload(deadline), WEBSOCKET_RELOAD_POLL_MS);
        });
    };

    const armReload = () => {
      reloadTimeout = setTimeout(() => {
        reloadTimeout = setTimeout(
          () => pollReadinessAndReload(Date.now() + WEBSOCKET_RELOAD_READINESS_MS),
          0,
        );
      }, WEBSOCKET_RELOAD_GRACE_MS);
    };

    const clearRetry = () => {
      if (reconnectTimeoutRef.current !== null) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };

    const connect = () => {
      if (!isCurrentWebSocketLifecycle(lifecycleRef.current, lifecycle) || !canConnect) return;
      clearRetry();

      const wsUrl = buildWebSocketUrl(token);
      if (!wsUrl) {
        console.warn('No authentication token found for WebSocket connection');
        return;
      }

      try {
        logDiagnostic({ level: 'info', area: 'websocket', event: 'connection_started', connectionEpoch: connectionEpochRef.current, metadata: { lifecycle } });
        const websocket = new WebSocket(wsUrl);
        wsRef.current = websocket;

        websocket.onopen = () => {
          if (wsRef.current !== websocket || !isCurrentWebSocketLifecycle(lifecycleRef.current, lifecycle)) return;
          clearReload();
          retryAttempt = 0;
          hasConnectedRef.current = true;
          setIsConnected(true);
          const epoch = connectionEpochRef.current + 1;
          connectionEpochRef.current = epoch;
          setConnectionEpoch(epoch);
          if (epoch > 1) incrementDiagnosticMetric('websocketReconnect');
          logDiagnostic({ level: 'info', area: 'websocket', event: epoch > 1 ? 'connection_reconnected' : 'connection_opened', connectionEpoch: epoch, outcome: 'connected' });
          dispatch({ kind: 'websocket_reconnected', connectionEpoch: epoch, timestamp: Date.now() });
        };

        websocket.onmessage = (event) => {
          if (wsRef.current !== websocket || !isCurrentWebSocketLifecycle(lifecycleRef.current, lifecycle)) return;
          try {
            dispatch(JSON.parse(event.data) as ServerEvent);
          } catch (error) {
            incrementDiagnosticMetric('contractValidationFailure');
            logDiagnostic({ level: 'warn', area: 'websocket', event: 'frame_parse_failed', connectionEpoch: connectionEpochRef.current, outcome: 'rejected', code: 'MALFORMED_FRAME', metadata: { dataType: typeof event.data } });
            console.error('Error parsing WebSocket message:', error);
          }
        };

        websocket.onclose = (closeEvent) => {
          const isCurrentSocket = wsRef.current === websocket;
          if (!isCurrentSocket || !isCurrentWebSocketLifecycle(lifecycleRef.current, lifecycle)) return;
          setIsConnected(false);
          replayingSessionsRef.current.clear();
          setReplayingSubscriptions(0);
          wsRef.current = null;
          logDiagnostic({ level: 'warn', area: 'websocket', event: 'connection_closed', connectionEpoch: connectionEpochRef.current, outcome: intentionalClose ? 'intentional' : 'disconnected', code: String(closeEvent.code), metadata: { clean: closeEvent.wasClean } });
          if (shouldArmWebSocketReload({
            intentional: intentionalClose,
            isCurrentSocket,
            canConnect,
            hasConnected: hasConnectedRef.current,
            reloadPending: reloadTimeout !== null,
            reloadConsumed: reloadWasConsumed(),
          })) armReload();
          if (!shouldRetryWebSocketClose({ intentional: intentionalClose, isCurrentSocket, canConnect })) return;
          clearRetry();
          const delay = getWebSocketRetryDelay(retryAttempt, Math.random());
          retryAttempt += 1;
          logDiagnostic({ level: 'info', area: 'websocket', event: 'reconnect_scheduled', connectionEpoch: connectionEpochRef.current, durationMs: delay, metadata: { attempt: retryAttempt } });
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectTimeoutRef.current = null;
            connect();
          }, delay);
        };

        websocket.onerror = (error) => {
          if (wsRef.current === websocket && isCurrentWebSocketLifecycle(lifecycleRef.current, lifecycle)) {
            logDiagnostic({ level: 'warn', area: 'websocket', event: 'connection_error', connectionEpoch: connectionEpochRef.current, outcome: 'transport_error' });
            console.error('WebSocket error:', error);
          }
        };
      } catch (error) {
        logDiagnostic({ level: 'error', area: 'websocket', event: 'connection_failed', connectionEpoch: connectionEpochRef.current, outcome: 'failure', code: 'CONNECTION_CREATE_FAILED' });
        console.error('Error creating WebSocket connection:', error);
        const delay = getWebSocketRetryDelay(retryAttempt, Math.random());
        retryAttempt += 1;
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = null;
          connect();
        }, delay);
      }
    };

    setIsConnected(false);
    if (canConnect) connect();

    return () => {
      intentionalClose = true;
      lifecycleRef.current += 1;
      clearRetry();
      clearReload();
      const activeSocket = wsRef.current;
      if (activeSocket) {
        activeSocket.onopen = null;
        activeSocket.onmessage = null;
        activeSocket.onclose = null;
        activeSocket.onerror = null;
        activeSocket.close();
        wsRef.current = null;
      }
    };
  }, [confirmReload, dispatch, isAuthLoading, token, user]);

  useEffect(() => {
    let pollTimeout: ReturnType<typeof setTimeout> | null = null;
    let abortController: AbortController | null = null;
    let reloadPending = false;

    const schedulePoll = (delay = CLIENT_BUILD_POLL_MS) => {
      if (pollTimeout !== null) clearTimeout(pollTimeout);
      pollTimeout = setTimeout(pollForClientBuild, delay);
    };

    const pollForClientBuild = () => {
      pollTimeout = null;
      if (document.visibilityState === 'hidden' || reloadPending) {
        schedulePoll();
        return;
      }

      const controller = new AbortController();
      abortController = controller;
      const fetchTimeout = setTimeout(() => controller.abort(), CLIENT_BUILD_FETCH_TIMEOUT_MS);
      const versionUrl = getClientBuildVersionUrl(document.baseURI);
      void fetch(versionUrl, { cache: 'no-store', signal: controller.signal })
        .then((response) => response.ok ? response.json() as Promise<{ build?: unknown }> : null)
        .then((resource) => {
          const servedBuildId = parseClientBuildResource(resource);
          if (!shouldReloadForClientBuild({
            currentBuildId: __CLOUDCLI_CLIENT_BUILD_ID__,
            servedBuildId,
            reloadPending,
          })) return;
          if (!confirmReload('A newer CloudCLI build is available. Reload now?')) return;
          reloadPending = true;
          window.location.reload();
        })
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(fetchTimeout);
          if (abortController === controller) abortController = null;
          if (!reloadPending) schedulePoll();
        });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && !reloadPending) schedulePoll(0);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    schedulePoll();
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (pollTimeout !== null) clearTimeout(pollTimeout);
      abortController?.abort();
    };
  }, [confirmReload]);

  const sendMessage = useCallback((message: unknown) => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      if (
        typeof message === 'object'
        && message !== null
        && 'kind' in message
        && message.kind === 'chat.subscribe'
        && 'sessionId' in message
        && typeof message.sessionId === 'string'
      ) {
        replayingSessionsRef.current.add(message.sessionId);
        setReplayingSubscriptions(replayingSessionsRef.current.size);
        logDiagnostic({ level: 'info', area: 'websocket', event: 'replay_requested', sessionId: message.sessionId, connectionEpoch: connectionEpochRef.current, generation: 'generation' in message && typeof message.generation === 'number' ? message.generation : undefined, seq: 'lastSeq' in message && typeof message.lastSeq === 'number' ? message.lastSeq : undefined });
      }
      try {
        socket.send(JSON.stringify(message));
        return true;
      } catch (error) {
        logDiagnostic({ level: 'warn', area: 'websocket', event: 'send_rejected', connectionEpoch: connectionEpochRef.current, outcome: 'transport_error' });
        console.warn('WebSocket send failed:', error);
        return false;
      }
    } else {
      logDiagnostic({ level: 'warn', area: 'websocket', event: 'send_rejected', connectionEpoch: connectionEpochRef.current, outcome: 'not_connected' });
      console.warn('WebSocket not connected');
      return false;
    }
  }, []);

  const subscribe: SubscribeToServerEvents = useCallback((
    guardOrListener: ServerEventListener | ServerEventGuard<ServerEvent>,
    narrowedListener?: ServerEventListener,
  ) => {
    const listener = narrowedListener
      ? (event: ServerEvent) => {
          if (guardOrListener(event)) narrowedListener(event);
        }
      : guardOrListener as ServerEventListener;
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const canConnect = IS_PLATFORM || (!isAuthLoading && Boolean(user));
  const transportState = getWebSocketTransportState({
    canConnect,
    isAuthLoading,
    isConnected,
    hasConnected: hasConnectedRef.current,
    replayingSubscriptions,
  });

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    subscribe,
    isConnected,
    connectionEpoch,
    transportState,
  }), [sendMessage, subscribe, isConnected, connectionEpoch, transportState]);

  return value;
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();

  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};
