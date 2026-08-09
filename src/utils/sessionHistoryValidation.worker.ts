/// <reference lib="webworker" />

import { validateSessionHistoryMessageChunk } from '../../shared/cloudcli-contracts';

import type { SessionHistoryWorkerRequest, SessionHistoryWorkerResponse } from './sessionHistoryValidation';

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = (event: MessageEvent<SessionHistoryWorkerRequest>) => {
  const { id, messages, startIndex } = event.data;
  const response: SessionHistoryWorkerResponse = {
    id,
    result: validateSessionHistoryMessageChunk(messages, startIndex),
  };
  workerScope.postMessage(response);
};

export {};
