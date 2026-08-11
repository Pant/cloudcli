import type { NormalizedMessage } from './normalizedMessage';

export interface CanonicalResponseMetadataSnapshot {
  count: number;
  signature: string;
  latestResponseHasMetadata: boolean;
}

function isOpenCodeRenderableAssistantResponse(message: NormalizedMessage): boolean {
  if (message.provider !== 'opencode') return false;
  if (message.kind === 'text') return message.role === 'assistant';
  return message.kind === 'thinking' || message.kind === 'tool_use';
}

/** Inspect only persisted canonical rows; merged realtime placeholders are not valid input. */
export function getCanonicalResponseMetadataSnapshot(
  messages: readonly NormalizedMessage[],
): CanonicalResponseMetadataSnapshot {
  const renderableResponses = messages.filter(isOpenCodeRenderableAssistantResponse);
  const metadataRows = renderableResponses.filter((message) => message.responseMetadata !== undefined);
  return {
    count: metadataRows.length,
    signature: metadataRows.map((message) => {
      const metadata = message.responseMetadata!;
      return `${message.id}\u001f${metadata.inputTokens}\u001f${metadata.outputTokens}\u001f${metadata.timestamp}`;
    }).join('\u001e'),
    latestResponseHasMetadata: renderableResponses.at(-1)?.responseMetadata !== undefined,
  };
}

export function isCanonicalResponseMetadataReady(
  baseline: CanonicalResponseMetadataSnapshot,
  current: CanonicalResponseMetadataSnapshot,
): boolean {
  const hasNewMetadata = current.count > baseline.count || current.signature !== baseline.signature;
  return hasNewMetadata && current.latestResponseHasMetadata;
}

export interface RealtimeCursor {
  generation: number;
  seq: number;
}

export type SequencedEventAcceptance =
  | { status: 'accepted'; cursor: RealtimeCursor; generationChanged: boolean }
  | { status: 'duplicate' | 'stale_generation'; cursor: RealtimeCursor }
  | { status: 'gap'; cursor: RealtimeCursor; expectedSeq: number };

export function acceptSequencedEvent(
  cursor: RealtimeCursor | null,
  generation: number,
  seq: number,
): SequencedEventAcceptance {
  const initial = cursor ?? { generation, seq: 0 };
  if (generation < initial.generation) return { status: 'stale_generation', cursor: initial };
  if (generation > initial.generation) {
    if (seq !== 1) return { status: 'gap', cursor: initial, expectedSeq: 1 };
    return { status: 'accepted', cursor: { generation, seq }, generationChanged: true };
  }
  if (seq <= initial.seq) return { status: 'duplicate', cursor: initial };
  if (seq !== initial.seq + 1) return { status: 'gap', cursor: initial, expectedSeq: initial.seq + 1 };
  return { status: 'accepted', cursor: { generation, seq }, generationChanged: false };
}

export interface RealtimeStreamState {
  generation: number;
  content: string;
  startedAt: string;
  provider?: NormalizedMessage['provider'];
  /** Deltas accepted since the last visible commit, retained without repeated string copies. */
  pendingChunks?: string[];
  /** @internal Last materialized prefix; avoids reading the joining content getter on acceptance. */
  committedContent?: string;
}

export function materializeRealtimeStream(stream: RealtimeStreamState): RealtimeStreamState {
  if (!stream.pendingChunks?.length) return stream;
  const content = (stream.committedContent ?? stream.content) + stream.pendingChunks.join('');
  return {
    ...stream,
    content,
    pendingChunks: [],
    committedContent: content,
  };
}

export function reduceRealtimeStream(
  stream: RealtimeStreamState | null,
  event: Pick<NormalizedMessage, 'kind' | 'content' | 'timestamp'> & { generation: number; provider?: NormalizedMessage['provider'] },
): RealtimeStreamState | null {
  if (event.kind === 'stream_delta') {
    const current = stream?.generation === event.generation ? stream : null;
    const pendingChunks = current?.pendingChunks ?? [];
    pendingChunks.push(event.content ?? '');
    const committedContent = current?.committedContent ?? current?.content ?? '';
    return {
      generation: event.generation,
      get content() { return committedContent + pendingChunks.join(''); },
      startedAt: current?.startedAt ?? event.timestamp,
      provider: current?.provider ?? event.provider,
      pendingChunks,
      committedContent,
    };
  }
  if (event.kind === 'stream_end' || event.kind === 'complete') {
    return stream?.generation === event.generation ? null : stream;
  }
  return stream;
}

/** Finalize the visible stream row while retaining terminal response usage. */
export function finalizeRealtimeStreamMessage(
  streamMessage: NormalizedMessage,
  terminalEvent: NormalizedMessage,
): NormalizedMessage {
  return {
    ...streamMessage,
    kind: 'text',
    role: 'assistant',
    ...(terminalEvent.responseMetadata !== undefined
      ? { responseMetadata: terminalEvent.responseMetadata }
      : {}),
  };
}

/** Keep one normalized row for each stable message id. */
export function deduplicateMessagesById(messages: readonly NormalizedMessage[]): NormalizedMessage[] {
  const seen = new Set<string>();
  const result: NormalizedMessage[] = [];
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    result.push(message);
  }
  return result;
}

/** Replace an existing row with the same id, or append it once if new. */
export function upsertMessageById(
  messages: readonly NormalizedMessage[],
  message: NormalizedMessage,
): NormalizedMessage[] {
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  if (index < 0) return [...messages, message];
  const result = [...messages];
  result[index] = message;
  return result;
}

export function shouldApplyCacheHydration(args: {
  hydrationGeneration: number;
  currentGeneration: number;
  hydrationTicket: number;
  currentHydrationTicket: number;
  appliedFetchTicket: number;
}): boolean {
  return args.hydrationGeneration === args.currentGeneration
    && args.hydrationTicket === args.currentHydrationTicket
    && args.appliedFetchTicket === 0;
}

export type RevisionAcceptance = 'accept' | 'same' | 'reject';

/** Opaque revisions are comparable only for equality; fetch tickets establish freshness. */
export function acceptCanonicalRevision(current: string | null, incoming: string, staleTicket: boolean): RevisionAcceptance {
  if (staleTicket) return 'reject';
  return current === incoming ? 'same' : 'accept';
}

export function canReuseNotModified(localRevision: string | null, responseRevision: string): boolean {
  return localRevision !== null && localRevision === responseRevision;
}

/**
 * A matching revision is reusable only when its complete canonical row set is
 * present. Metadata can outlive missing/corrupt IndexedDB message rows, so the
 * revision alone must never turn a 304 into an empty or truncated history.
 */
export function hasCompleteCanonicalSnapshot(args: {
  canonicalRevision: string | null;
  serverMessageCount: number;
  total: number;
  hasMore: boolean;
  offset: number;
}): boolean {
  return args.canonicalRevision !== null
    && !args.hasMore
    && Number.isInteger(args.total)
    && args.total >= 0
    && args.total === args.serverMessageCount
    && args.offset === args.serverMessageCount;
}

export interface SessionWarmupPolicyArgs {
  hasCompleteSnapshot: boolean;
  fetchedAt: number;
  now: number;
  staleThresholdMs: number;
  messageCount: number;
}

export interface SessionWarmupPolicy {
  reuseFreshSnapshot: boolean;
  hasDisplayableMessages: boolean;
  requiresCanonicalFetch: boolean;
}

/** Pure policy shared by anticipatory warm-up and committed session loading. */
export function getSessionWarmupPolicy(args: SessionWarmupPolicyArgs): SessionWarmupPolicy {
  const reuseFreshSnapshot = args.hasCompleteSnapshot
    && args.fetchedAt > 0
    && args.now - args.fetchedAt <= args.staleThresholdMs;
  return {
    reuseFreshSnapshot,
    hasDisplayableMessages: args.messageCount > 0,
    requiresCanonicalFetch: !reuseFreshSnapshot,
  };
}
