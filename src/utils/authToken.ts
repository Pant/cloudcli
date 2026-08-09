export const AUTH_TOKEN_REFRESHED_EVENT = 'auth-token-refreshed';
export const AUTH_SESSION_EXPIRED_EVENT = 'auth-session-expired';

export const isValidRefreshedToken = (token: unknown): token is string =>
  typeof token === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);

const readTokenClaims = (token: unknown): { issuedAt: number; expiresAt: number } | null => {
  if (!isValidRefreshedToken(token)) return null;
  try {
    const encodedPayload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const paddedPayload = encodedPayload.padEnd(encodedPayload.length + ((4 - (encodedPayload.length % 4)) % 4), '=');
    const payload: unknown = JSON.parse(atob(paddedPayload));
    if (!payload || typeof payload !== 'object') return null;
    const { iat, exp } = payload as Record<string, unknown>;
    if (typeof iat !== 'number' || !Number.isFinite(iat) || typeof exp !== 'number' || !Number.isFinite(exp)) return null;
    return { issuedAt: iat * 1000, expiresAt: exp * 1000 };
  } catch {
    return null;
  }
};

export const isAuthTokenExpired = (token: unknown): boolean => {
  const claims = readTokenClaims(token);
  return claims ? Date.now() >= claims.expiresAt : false;
};

export const getAuthTokenRefreshDelay = (token: unknown): number | null => {
  const claims = readTokenClaims(token);
  if (!claims) return null;
  return Math.max(0, claims.issuedAt + ((claims.expiresAt - claims.issuedAt) / 2) - Date.now());
};

export const expireAuthSession = (): void => {
  localStorage.removeItem('auth-token');
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(AUTH_SESSION_EXPIRED_EVENT));
};

export const getStoredAuthToken = (): string | null => {
  const token = localStorage.getItem('auth-token');
  if (token && isAuthTokenExpired(token)) {
    expireAuthSession();
    return null;
  }
  return token;
};

export const storeAuthToken = (token: unknown): boolean => {
  if (!isValidRefreshedToken(token)) return false;
  localStorage.setItem('auth-token', token);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(AUTH_TOKEN_REFRESHED_EVENT, { detail: token }));
  return true;
};
