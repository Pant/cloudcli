import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '../components/auth/context/authContextContract';
import { IS_PLATFORM } from '../constants/config';
import { expireAuthSession, isAuthTokenExpired } from '../utils/api';

import {
  getWebSocketRetryDelay,
  isCurrentWebSocketLifecycle,
  shouldRetryWebSocketClose,
} from './webSocketTransport';
import WebSocketContext from './webSocketContextValue';
import type { ServerEvent, ServerEventListener, WebSocketContextType } from './webSocketTypes';

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

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const lifecycleRef = useRef(0);
  const connectionEpochRef = useRef(0);
  /**
   * Listener registry for the subscribe API. A ref (not state) because the
   * set must be readable synchronously inside `onmessage` and never trigger
   * re-renders of the provider tree.
   */
  const listenersRef = useRef(new Set<ServerEventListener>());
  const [latestMessage, setLatestMessage] = useState<ServerEvent | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { isLoading: isAuthLoading, token, user } = useAuth();

  const dispatch = useCallback((event: ServerEvent) => {
    for (const listener of listenersRef.current) {
      try {
        listener(event);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    }
    setLatestMessage(event);
  }, []);

  useEffect(() => {
    const lifecycle = lifecycleRef.current + 1;
    lifecycleRef.current = lifecycle;
    let intentionalClose = false;
    let retryAttempt = 0;
    const canConnect = IS_PLATFORM || (!isAuthLoading && Boolean(user));

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
        const websocket = new WebSocket(wsUrl);
        wsRef.current = websocket;

        websocket.onopen = () => {
          if (wsRef.current !== websocket || !isCurrentWebSocketLifecycle(lifecycleRef.current, lifecycle)) return;
          retryAttempt = 0;
          setIsConnected(true);
          const epoch = connectionEpochRef.current + 1;
          connectionEpochRef.current = epoch;
          setConnectionEpoch(epoch);
          dispatch({ kind: 'websocket_reconnected', connectionEpoch: epoch, timestamp: Date.now() });
        };

        websocket.onmessage = (event) => {
          if (wsRef.current !== websocket || !isCurrentWebSocketLifecycle(lifecycleRef.current, lifecycle)) return;
          try {
            dispatch(JSON.parse(event.data) as ServerEvent);
          } catch (error) {
            console.error('Error parsing WebSocket message:', error);
          }
        };

        websocket.onclose = () => {
          const isCurrentSocket = wsRef.current === websocket;
          if (!isCurrentSocket || !isCurrentWebSocketLifecycle(lifecycleRef.current, lifecycle)) return;
          setIsConnected(false);
          wsRef.current = null;
          if (!shouldRetryWebSocketClose({ intentional: intentionalClose, isCurrentSocket, canConnect })) return;
          clearRetry();
          const delay = getWebSocketRetryDelay(retryAttempt, Math.random());
          retryAttempt += 1;
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectTimeoutRef.current = null;
            connect();
          }, delay);
        };

        websocket.onerror = (error) => {
          if (wsRef.current === websocket && isCurrentWebSocketLifecycle(lifecycleRef.current, lifecycle)) {
            console.error('WebSocket error:', error);
          }
        };
      } catch (error) {
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
  }, [dispatch, isAuthLoading, token, user]);

  const sendMessage = useCallback((message: unknown) => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      return true;
    } else {
      console.warn('WebSocket not connected');
      return false;
    }
  }, []);

  const subscribe = useCallback((listener: ServerEventListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    subscribe,
    latestMessage,
    isConnected,
    connectionEpoch,
  }), [sendMessage, subscribe, latestMessage, isConnected, connectionEpoch]);

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
