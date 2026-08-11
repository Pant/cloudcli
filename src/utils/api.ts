// The compatibility API intentionally retains broad endpoint signatures while
// consumers migrate incrementally to apiClient.
// @ts-nocheck
import { IS_PLATFORM } from "../constants/config";

import { apiClient } from './apiClient';
export * from './authToken';
import { expireAuthSession, getStoredAuthToken, storeAuthToken } from './authToken';

// Utility function for authenticated API calls
export const authenticatedFetch = (url, options = {}) => {
  const token = getStoredAuthToken();

  const defaultHeaders = {};

  // Only set Content-Type for non-FormData requests
  if (!(options.body instanceof FormData)) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  if (!IS_PLATFORM && token) {
    defaultHeaders['Authorization'] = `Bearer ${token}`;
  }

  return fetch(url, {
    ...options,
    headers: {
      ...defaultHeaders,
      ...options.headers,
    },
  }).then((response) => {
    const refreshedToken = response.headers.get('X-Refreshed-Token');
    if (refreshedToken) {
      storeAuthToken(refreshedToken);
    }
    if (response.headers.get('X-Auth-Error')) {
      expireAuthSession();
    }
    return response;
  });
};

/**
 * Build the optional File Tree query without requiring callers to concatenate
 * or encode query strings themselves.  The API's root listing is represented
 * by an omitted `targetPath`; `path` is supported as a convenience alias.
 *
 * @param {Record<string, unknown>} options
 * @returns {string}
 */
export const buildFileTreeQuery = (options = {}) => {
  const params = new URLSearchParams();
  const targetPath = options.targetPath ?? options.path;
  const includeMetadata = options.includeMetadata ?? options.metadata;

  if (typeof targetPath === 'string' && targetPath.length > 0 && targetPath !== '.') {
    params.set('targetPath', targetPath);
  }
  if (typeof options.depth === 'number' && Number.isFinite(options.depth)) {
    params.set('depth', String(options.depth));
  }
  if (typeof includeMetadata === 'boolean') {
    params.set('includeMetadata', String(includeMetadata));
  }
  if (typeof options.respectGitignore === 'boolean') {
    params.set('respectGitignore', String(options.respectGitignore));
  }

  return params.toString();
};

/**
 * @param {string} projectId
 * @param {Record<string, unknown>} options
 * @returns {string}
 */
export const buildFileTreeUrl = (projectId, options = {}) => {
  const query = buildFileTreeQuery(options);
  return `/api/file-tree/projects/${encodeURIComponent(projectId)}/files${query ? `?${query}` : ''}`;
};

export const buildFileTreePageUrl = (projectId, options = {}) => {
  const params = new URLSearchParams(buildFileTreeQuery(options));
  if (typeof options.offset === 'number' && Number.isFinite(options.offset)) params.set('offset', String(options.offset));
  if (typeof options.limit === 'number' && Number.isFinite(options.limit)) params.set('limit', String(options.limit));
  const query = params.toString();
  return `/api/file-tree/projects/${encodeURIComponent(projectId)}/files/page${query ? `?${query}` : ''}`;
};

// API endpoints
export const api = {
  // Auth endpoints (no token required)
  auth: {
    status: () => fetch('/api/auth/status'),
    login: (username, password) => fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    register: (username, password) => fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    refresh: () => authenticatedFetch('/api/auth/refresh', { method: 'POST' }),
    user: () => authenticatedFetch('/api/auth/user'),
    logout: () => authenticatedFetch('/api/auth/logout', { method: 'POST' }),
  },

  // Protected endpoints
  // config endpoint removed - no longer needed (frontend uses window.location)
  // After the projectName → projectId migration the path/query identifier is
  // the DB-assigned `projectId`; parameter names reflect that for clarity.
  projects: () => authenticatedFetch('/api/projects'),
  archivedProjects: () => authenticatedFetch('/api/projects/archived'),
  projectSessions: (projectId, { limit = 20, offset = 0 } = {}) => {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    return authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/sessions?${params.toString()}`);
  },
  listProjectAppointments: (projectId) =>
    authenticatedFetch(`/api/appointments/${encodeURIComponent(projectId)}`),
  createProjectAppointment: (projectId, appointment) =>
    authenticatedFetch(`/api/appointments/${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify(appointment),
    }),
  reorderProjectAppointments: (projectId, appointmentIds) =>
    authenticatedFetch(`/api/appointments/${encodeURIComponent(projectId)}/queue`, {
      method: 'PUT',
      body: JSON.stringify({ appointmentIds }),
    }),
  setAppointmentActive: (projectId, appointmentId, isActive) =>
    authenticatedFetch(`/api/appointments/${encodeURIComponent(projectId)}/${encodeURIComponent(appointmentId)}/active`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive }),
    }),
  dispatchProjectAppointment: (projectId, appointmentId) =>
    authenticatedFetch(`/api/appointments/${encodeURIComponent(projectId)}/${encodeURIComponent(appointmentId)}/dispatch`, {
      method: 'POST',
    }),
  postponeAppointment: (projectId, appointmentId, dueAt) =>
    authenticatedFetch(`/api/appointments/${encodeURIComponent(projectId)}/${encodeURIComponent(appointmentId)}/postpone`, {
      method: 'PATCH',
      body: JSON.stringify({ dueAt }),
    }),
  cancelAppointment: (projectId, appointmentId) =>
    authenticatedFetch(`/api/appointments/${encodeURIComponent(projectId)}/${encodeURIComponent(appointmentId)}`, { method: 'DELETE' }),
  // Unified endpoint for persisted session messages.
  // Provider/project metadata are resolved by the backend from sessionId.
  unifiedSessionMessages: (sessionId, _provider = 'claude', { limit = null, offset = 0 } = {}) => {
    const params = new URLSearchParams();
    if (limit !== null) {
      params.append('limit', String(limit));
      params.append('offset', String(offset));
    }
    const queryString = params.toString();
    return authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(sessionId)}/messages${queryString ? `?${queryString}` : ''}`);
  },
  renameProject: (projectId, displayName) =>
    authenticatedFetch(`/api/projects/${projectId}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ displayName }),
    }),
  restoreProject: (projectId) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/restore`, {
      method: 'POST',
    }),
  // Session deletion now mirrors project deletion:
  // - default: archive only (`isArchived = 1`)
  // - hardDelete: remove the row and, by default, its persisted transcript file
  deleteSession: (sessionId, hardDelete = false, options) => apiClient.deleteSession(sessionId, hardDelete, options),
  getArchivedSessions: () =>
    authenticatedFetch('/api/providers/sessions/archived'),
  // Resolves one session (by app id or provider-native id) to its metadata and
  // owning project — used when a /session/<id> URL isn't in loaded payloads.
  sessionDetails: (sessionId) =>
    authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(sessionId)}`),
  runningSessions: (options) => apiClient.runningSessions(options),
  sessionLifecycleStatus: (options) => apiClient.sessionLifecycleStatus(options),
  startSession: (sessionId, options) => apiClient.startSession(sessionId, options),
  providerSessionId: (sessionId) =>
    authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(sessionId)}/provider-id`),
  restoreSession: (sessionId) =>
    authenticatedFetch(`/api/providers/sessions/${sessionId}/restore`, {
      method: 'POST',
    }),
  renameSession: (sessionId, summary, options) => apiClient.renameSession(sessionId, summary, options),
  // `hardDelete` => server `?force=true` (remove DB row + Claude *.jsonl + sessions rows for path).
  deleteProject: (projectId, hardDelete = false) => {
    const params = new URLSearchParams();
    if (hardDelete) params.set('force', 'true');
    const qs = params.toString();
    return authenticatedFetch(`/api/projects/${projectId}${qs ? `?${qs}` : ''}`, {
      method: 'DELETE',
    });
  },
  searchConversationsUrl: (query, limit = 50) => {
    const token = getStoredAuthToken();
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (token) params.set('token', token);
    return `/api/providers/search/sessions?${params.toString()}`;
  },
  createProject: (projectData) =>
    authenticatedFetch('/api/projects/create-project', {
      method: 'POST',
      body: JSON.stringify(projectData),
    }),
  migrateLegacyProjectStars: (projectIds) =>
    authenticatedFetch('/api/projects/migrate-legacy-stars', {
      method: 'POST',
      body: JSON.stringify({ projectIds }),
    }),
  toggleProjectStar: (projectId) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/toggle-star`, {
      method: 'POST',
    }),
  readFile: (projectId, filePath) =>
    authenticatedFetch(`/api/file-tree/projects/${projectId}/file?filePath=${encodeURIComponent(filePath)}`),
  readFileBlob: (projectId, filePath) =>
    authenticatedFetch(`/api/file-tree/projects/${projectId}/files/content?path=${encodeURIComponent(filePath)}`),
  saveFile: (projectId, filePath, content) =>
    authenticatedFetch(`/api/file-tree/projects/${projectId}/file`, {
      method: 'PUT',
      body: JSON.stringify({ filePath, content }),
    }),
  getFiles: (projectId, options = {}) => {
    const {
      targetPath: _targetPath,
      path: _path,
      depth: _depth,
      includeMetadata: _includeMetadata,
      metadata: _metadata,
      respectGitignore: _respectGitignore,
      ...fetchOptions
    } = options;
    return authenticatedFetch(buildFileTreeUrl(projectId, options), fetchOptions);
  },
  getFileTreePage: (projectId, options = {}) => {
    const {
      targetPath: _targetPath, path: _path, includeMetadata: _includeMetadata,
      metadata: _metadata, respectGitignore: _respectGitignore,
      offset: _offset, limit: _limit, ...fetchOptions
    } = options;
    return authenticatedFetch(buildFileTreePageUrl(projectId, options), fetchOptions);
  },
  getMentionableFiles: (projectId, options = {}) => {
    const {
      targetPath: _targetPath,
      path: _path,
      depth: _depth,
      includeMetadata: _includeMetadata,
      metadata: _metadata,
      respectGitignore: _respectGitignore,
      ...fetchOptions
    } = options;
    return authenticatedFetch(
      buildFileTreeUrl(projectId, { ...options, respectGitignore: true }),
      fetchOptions,
    );
  },

  // File operations
  createFile: (projectId, { path, type, name }) =>
    authenticatedFetch(`/api/file-tree/projects/${projectId}/files/create`, {
      method: 'POST',
      body: JSON.stringify({ path, type, name }),
    }),

  renameFile: (projectId, { oldPath, newName }) =>
    authenticatedFetch(`/api/file-tree/projects/${projectId}/files/rename`, {
      method: 'PUT',
      body: JSON.stringify({ oldPath, newName }),
    }),

  deleteFile: (projectId, { path, type }) =>
    authenticatedFetch(`/api/file-tree/projects/${projectId}/files`, {
      method: 'DELETE',
      body: JSON.stringify({ path, type }),
    }),

  uploadFiles: (projectId, formData) =>
    authenticatedFetch(`/api/file-tree/projects/${projectId}/files/upload`, {
      method: 'POST',
      body: formData,
      headers: {}, // Let browser set Content-Type for FormData
    }),

  // Browse filesystem for project suggestions
  browseFilesystem: (dirPath = null) => {
    const params = new URLSearchParams();
    if (dirPath) params.append('path', dirPath);

    return authenticatedFetch(`/api/file-tree/browse-filesystem?${params}`);
  },

  createFolder: (folderPath) =>
    authenticatedFetch('/api/file-tree/create-folder', {
      method: 'POST',
      body: JSON.stringify({ path: folderPath }),
    }),

  // User endpoints
  user: {
    gitConfig: () => authenticatedFetch('/api/user/git-config'),
    updateGitConfig: (gitName, gitEmail) =>
      authenticatedFetch('/api/user/git-config', {
        method: 'POST',
        body: JSON.stringify({ gitName, gitEmail }),
      }),
    onboardingStatus: () => authenticatedFetch('/api/user/onboarding-status'),
    completeOnboarding: () =>
      authenticatedFetch('/api/user/complete-onboarding', {
        method: 'POST',
      }),
  },

  // Generic GET method for any endpoint
  get: (endpoint) => authenticatedFetch(`/api${endpoint}`),

  // Generic POST method for any endpoint
  post: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'POST',
    ...(body instanceof FormData ? { body } : { body: JSON.stringify(body) }),
  }),

  // Generic PUT method for any endpoint
  put: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }),

  // Generic DELETE method for any endpoint
  delete: (endpoint, options = {}) => authenticatedFetch(`/api${endpoint}`, {
    method: 'DELETE',
    ...options,
  }),
};
