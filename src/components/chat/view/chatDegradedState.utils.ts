import type { WebSocketTransportState } from '../../../contexts/webSocketTypes';
import type { SessionStatus } from '../../../stores/useSessionStore';

export type ChatDataState = 'loading-empty' | 'cached-validating' | 'replay-recovery' | 'stale-offline' | 'backend-unavailable' | 'unauthorized' | 'forbidden' | 'empty-success' | 'ready';

export function getChatDataState(input: { messageCount: number; loading: boolean; sessionStatus: SessionStatus; transportState: WebSocketTransportState; errorStatus?: number | null }): ChatDataState {
  if (input.errorStatus === 401) return 'unauthorized';
  if (input.errorStatus === 403) return 'forbidden';
  if (input.messageCount > 0 && input.loading) return 'cached-validating';
  if (input.messageCount > 0 && input.transportState === 'replaying') return 'replay-recovery';
  if (input.messageCount > 0 && (input.transportState === 'offline' || input.transportState === 'degraded')) return 'stale-offline';
  if (input.sessionStatus === 'error') return 'backend-unavailable';
  if (input.loading) return 'loading-empty';
  if (input.messageCount === 0) return 'empty-success';
  return 'ready';
}

export const CHAT_DATA_STATE_COPY: Partial<Record<ChatDataState, string>> = { 'cached-validating': 'Showing cached messages while canonical history is validated.', 'replay-recovery': 'Recovering missed realtime updates. Existing messages remain available.', 'stale-offline': 'Connection unavailable. Showing saved messages; recent updates may be missing.', 'backend-unavailable': 'Canonical chat history is unavailable.', unauthorized: 'Sign in again to load this chat history.', forbidden: 'You do not have permission to load this chat history.' };
