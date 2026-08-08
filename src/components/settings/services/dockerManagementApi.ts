import { authenticatedFetch } from '../../../utils/api';

type AuthenticatedFetcher = typeof authenticatedFetch;

const ENDPOINTS = {
  build: '/api/settings/docker-management/build',
  restart: '/api/settings/docker-management/restart',
  down: '/api/settings/docker-management/down',
} as const;

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
