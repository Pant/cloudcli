export type ServerEvent = {
  kind?: string;
  type?: string;
  sessionId?: string;
  seq?: number;
  [key: string]: unknown;
};

export type ServerEventListener = (event: ServerEvent) => void;

export type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: unknown) => boolean;
  subscribe: (listener: ServerEventListener) => () => void;
  latestMessage: ServerEvent | null;
  isConnected: boolean;
  connectionEpoch: number;
};
