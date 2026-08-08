import { AppError } from '@/shared/utils.js';

type DockerManagementAction = 'build' | 'restart' | 'down';

type DockerManagementDependencies = {
  baseUrl: string;
  credentialsFile?: string;
  username?: string;
  password?: string;
  timeoutMs: number;
  fetch: typeof fetch;
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
};

const ACTION_PATHS: Record<DockerManagementAction, string> = {
  build: '/api/build',
  restart: '/api/up',
  down: '/api/down',
};

function configurationError(): AppError {
  return new AppError('Docker management is not configured', {
    code: 'DOCKER_MANAGEMENT_NOT_CONFIGURED',
    statusCode: 503,
  });
}

function parseCredentials(content: string): { username: string; password: string } {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/u)) {
    const separator = line.indexOf(':');
    if (separator > 0) values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const username = values.get('username') ?? '';
  const password = values.get('password') ?? '';
  if (!username || !password) throw configurationError();
  return { username, password };
}

function upstreamError(status: number): AppError {
  if (status === 401 || status === 403) {
    return new AppError('Docker management authentication failed', {
      code: 'DOCKER_MANAGEMENT_AUTH_FAILED', statusCode: 502,
    });
  }
  if (status === 409) {
    return new AppError('Another Docker management operation is running', {
      code: 'DOCKER_MANAGEMENT_CONFLICT', statusCode: 409,
    });
  }
  return new AppError('Docker management rejected the request', {
    code: 'DOCKER_MANAGEMENT_UPSTREAM_ERROR', statusCode: 502,
  });
}

async function drainBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  const reader = body.getReader();
  try {
    while (!(await reader.read()).done) { /* discard bounded chunks */ }
  } finally {
    reader.releaseLock();
  }
}

/** Creates the Settings module's server-only client for fixed Docker management actions. */
export function createDockerManagementService(dependencies: DockerManagementDependencies) {
  const normalizedBaseUrl = dependencies.baseUrl.trim().replace(/\/+$/u, '');

  async function credentials(): Promise<{ username: string; password: string }> {
    if (dependencies.credentialsFile?.trim()) {
      try {
        return parseCredentials(await dependencies.readFile(dependencies.credentialsFile.trim(), 'utf8'));
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw configurationError();
      }
    }
    const username = dependencies.username?.trim() ?? '';
    const password = dependencies.password?.trim() ?? '';
    if (!username || !password) throw configurationError();
    return { username, password };
  }

  return {
    async trigger(action: DockerManagementAction): Promise<void> {
      if (!normalizedBaseUrl || !Number.isFinite(dependencies.timeoutMs) || dependencies.timeoutMs <= 0) {
        throw configurationError();
      }
      const auth = await credentials();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs);
      let response: Response;
      try {
        response = await dependencies.fetch(`${normalizedBaseUrl}${ACTION_PATHS[action]}`, {
          method: 'POST',
          headers: { Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` },
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new AppError('Docker management request timed out', {
            code: 'DOCKER_MANAGEMENT_TIMEOUT', statusCode: 504,
          });
        }
        throw new AppError('Docker management is unavailable', {
          code: 'DOCKER_MANAGEMENT_UNAVAILABLE', statusCode: 502,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) {
        void drainBody(response.body).catch(() => undefined);
        throw upstreamError(response.status);
      }
      void drainBody(response.body).catch(() => undefined);
    },
  };
}
