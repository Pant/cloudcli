import { authenticatedFetch } from '../../../utils/api';

type AuthenticatedFetcher = typeof authenticatedFetch;

const ENDPOINTS = {
  build: '/api/settings/docker-management/build',
  restart: '/api/settings/docker-management/restart',
  down: '/api/settings/docker-management/down',
  logs: '/api/settings/docker-management/logs',
} as const;

export const MAX_DOCKER_LOG_CHARACTERS = 100_000;

export class DockerManagementRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Docker management request was not accepted (HTTP ${status}).`);
    this.name = 'DockerManagementRequestError';
    this.status = status;
  }
}

const requestAcceptance = async (endpoint: string, fetcher: AuthenticatedFetcher): Promise<void> => {
  const response = await fetcher(endpoint, { method: 'POST' });
  if (response.status !== 202) {
    throw new DockerManagementRequestError(response.status);
  }
};

export const requestDockerBuild = (fetcher: AuthenticatedFetcher = authenticatedFetch): Promise<void> => (
  requestAcceptance(ENDPOINTS.build, fetcher)
);

export const requestDockerRestart = (fetcher: AuthenticatedFetcher = authenticatedFetch): Promise<void> => (
  requestAcceptance(ENDPOINTS.restart, fetcher)
);

export const requestDockerDown = (fetcher: AuthenticatedFetcher = authenticatedFetch): Promise<void> => (
  requestAcceptance(ENDPOINTS.down, fetcher)
);

export const appendBoundedDockerLogs = (current: string, chunk: string, limit = MAX_DOCKER_LOG_CHARACTERS): string => (
  `${current}${chunk}`.slice(-limit)
);

export const streamDockerLogs = async (
  onChunk: (chunk: string) => void,
  signal?: AbortSignal,
  fetcher: AuthenticatedFetcher = authenticatedFetch,
): Promise<void> => {
  const response = await fetcher(ENDPOINTS.logs, { method: 'GET', signal });
  if (!response.ok || !response.body) {
    throw new DockerManagementRequestError(response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const cancelReader = () => { void reader.cancel(); };
  signal?.addEventListener('abort', cancelReader, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (chunk) onChunk(chunk);
    }
    const remainder = decoder.decode();
    if (remainder) onChunk(remainder);
  } finally {
    signal?.removeEventListener('abort', cancelReader);
    await reader.cancel().catch(() => undefined);
  }
};
