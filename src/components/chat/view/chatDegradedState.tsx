import { CHAT_DATA_STATE_COPY, type ChatDataState } from './chatDegradedState.utils';

export function ChatStatusBanner({ state, onRetry }: { state: ChatDataState; onRetry?: () => void }) {
  const message = CHAT_DATA_STATE_COPY[state];
  if (!message) return null;
  return <div className="flex items-center justify-between gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950" role={['backend-unavailable', 'unauthorized', 'forbidden'].includes(state) ? 'alert' : 'status'}><span>{message}</span>{onRetry && state !== 'forbidden' && <button type="button" onClick={onRetry} className="shrink-0 rounded border border-amber-500 px-2 py-1 font-medium hover:bg-amber-100">Retry history</button>}</div>;
}
