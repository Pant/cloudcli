import type { ChatSubscribedEvent, SequencedChatEvent } from '../../shared/cloudcli-contracts';

export type LegacyServerEvent = {
  kind?: string;
  type?: string;
  sessionId?: string;
  seq?: number;
  [key: string]: unknown;
};

export type ServerEvent = LegacyServerEvent & (ChatSubscribedEvent | SequencedChatEvent | LegacyServerEvent);

export type ServerEventListener = (event: ServerEvent) => void;

export type WebSocketTransportState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'replaying'
  | 'degraded'
  | 'offline';

export type WebSocketReconnectEvent = LegacyServerEvent & {
  kind: 'websocket_reconnected';
  connectionEpoch: number;
  timestamp: number;
};

export type ServerEventGuard<Event extends ServerEvent> = (event: ServerEvent) => event is Event;

export type SubscribeToServerEvents = {
  (listener: ServerEventListener): () => void;
  <Event extends ServerEvent>(guard: ServerEventGuard<Event>, listener: (event: Event) => void): () => void;
};

export function isChatServerEvent(event: ServerEvent): event is ChatSubscribedEvent | SequencedChatEvent {
  return event.kind === 'chat_subscribed'
    || (typeof event.kind === 'string'
      && typeof event.sessionId === 'string'
      && typeof event.seq === 'number');
}

export function isWebSocketReconnectEvent(event: ServerEvent): event is WebSocketReconnectEvent {
  return event.kind === 'websocket_reconnected'
    && typeof event.connectionEpoch === 'number'
    && typeof event.timestamp === 'number';
}

export type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: unknown) => boolean;
  subscribe: SubscribeToServerEvents;
  isConnected: boolean;
  connectionEpoch: number;
  transportState: WebSocketTransportState;
};
