import { promises as fs } from 'node:fs';

import {
  apiKeysDb,
  credentialsDb,
  notificationPreferencesDb,
  pushSubscriptionsDb,
} from '@/modules/database/index.js';
import {
  createNotificationEvent,
  getPublicKey,
  notifyUserIfEnabled,
} from '@/modules/notifications/index.js';

import { createDockerManagementService } from './docker-management.service.js';
import { createSettingsRouter } from './settings.routes.js';
import { createSettingsService } from './settings.service.js';

const dockerManagement = createDockerManagementService({
  baseUrl: process.env.DOCKER_MANAGEMENT_API_URL ?? 'https://management.code.pantelis.ninja',
  credentialsFile: process.env.DOCKER_MANAGEMENT_API_CREDENTIALS_FILE,
  username: process.env.DOCKER_MANAGEMENT_API_USERNAME,
  password: process.env.DOCKER_MANAGEMENT_API_PASSWORD,
  timeoutMs: Number(process.env.DOCKER_MANAGEMENT_API_TIMEOUT_MS ?? 10_000),
  fetch,
  readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
});

const settingsService = createSettingsService({
  dockerManagement,
  apiKeys: {
    list: (userId) => apiKeysDb.getApiKeys(userId),
    create: (userId, keyName) => apiKeysDb.createApiKey(userId, keyName),
    remove: (userId, keyId) => apiKeysDb.deleteApiKey(userId, keyId),
    toggle: (userId, keyId, isActive) => apiKeysDb.toggleApiKey(userId, keyId, isActive),
  },
  credentials: {
    list: (userId, type) => credentialsDb.getCredentials(userId, type),
    create: (userId, name, type, value, description) =>
      credentialsDb.createCredential(userId, name, type, value, description),
    remove: (userId, credentialId) => credentialsDb.deleteCredential(userId, credentialId),
    toggle: (userId, credentialId, isActive) =>
      credentialsDb.toggleCredential(userId, credentialId, isActive),
  },
  notifications: {
    getPreferences: (userId) => notificationPreferencesDb.getPreferences(userId),
    updatePreferences: (userId, preferences) =>
      notificationPreferencesDb.updatePreferences(userId, preferences),
    createEnabledEvent: () => createNotificationEvent({
      provider: 'system', kind: 'info', code: 'push.enabled',
      meta: { message: 'Push notifications are now enabled!' }, severity: 'info',
    }),
    notifyUser: (userId, event) => notifyUserIfEnabled({ userId, event }),
  },
  pushSubscriptions: {
    save: (userId, endpoint, p256dh, auth) =>
      pushSubscriptionsDb.saveSubscription(userId, endpoint, p256dh, auth),
    remove: (endpoint) => pushSubscriptionsDb.removeSubscription(endpoint),
  },
  getVapidPublicKey: getPublicKey,
});

/** Settings router assembled for the authenticated server mount. */
export const settingsRoutes = createSettingsRouter(settingsService);
