import { createContext } from 'react';

import type { WebSocketContextType } from './webSocketTypes';

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export default WebSocketContext;
