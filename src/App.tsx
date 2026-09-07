import { useEffect } from 'react';
import { BrowserRouter as Router, useRoutes } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import type { i18n as I18nInstance } from 'i18next';

import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider, ProtectedRoute } from './components/auth';
import { useAuth } from './components/auth/context/authContextContract';
import { WebSocketProvider } from './contexts/WebSocketContext';
import { PluginsProvider } from './contexts/PluginsContext';
import { appRoutes } from './appRoutes';
import { SessionStoreProvider } from './stores/sessionStoreProvider';
import { SessionMessageCacheCoordinator } from './stores/SessionMessageCacheCoordinator';
import ErrorBoundary from './components/main-content/view/ErrorBoundary';
import { markCloudCliLifecycle } from './lib/performanceDiagnostics';
import { ReloadSafetyProvider } from './contexts/ReloadSafetyContext';
import { inferRouterBasename, type RouterBasenameHint } from './routerBasename';

/**
 * Detect the router basename from explicit runtime config or deployment hints.
 *
 * CloudCLI can be served from a path prefix by a reverse proxy, for example:
 *   /ai/manifest.json
 *   /ai/assets/index-abc123.js
 *   /ai/icons/icon-192x192.png
 *
 * React Router needs that prefix as its basename, but the packaged app should
 * also keep working when served directly from the domain root. The direct-root
 * case is easy to misread because asset URLs such as /icons/icon-192x192.png
 * contain a directory even though there is no application basename.
 */
function detectRouterBasename() {
  const explicitBasename = typeof window !== 'undefined' ? window.__ROUTER_BASENAME__ || '' : '';
  if (explicitBasename) {
    // Keep the deployment escape hatch authoritative. A trailing slash is
    // harmless for humans but React Router expects a normalized basename.
    return explicitBasename.replace(/\/+$/, '');
  }

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return '';
  }

  const candidatePaths: RouterBasenameHint[] = [
    { kind: 'manifest' as const, value: document.querySelector('link[rel="manifest"]')?.getAttribute('href') },
    { kind: 'script' as const, value: document.querySelector('script[type="module"][src]')?.getAttribute('src') },
    ...Array.from(
      document.querySelectorAll(
        'link[rel~="icon"][href], link[rel="apple-touch-icon"][href], link[rel="apple-touch-icon-precomposed"][href], link[rel="mask-icon"][href]'
      )
    ).map((node) => ({
      kind: 'icon' as const,
      value: node.getAttribute('href'),
    })),
  ].filter((candidate): candidate is RouterBasenameHint => Boolean(candidate.value));

  return inferRouterBasename({
    explicitBasename,
    baseUrl: document.baseURI || window.location.href,
    origin: window.location.origin,
    hints: candidatePaths,
  });
}

export default function App({ i18n }: { i18n: I18nInstance }) {
  const routerBasename = detectRouterBasename();

  return (
    <ErrorBoundary area="application" name="Application" root showDetails retryLabel="Reload CloudCLI" onRetry={() => window.location.reload()}>
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <AuthProvider>
          <AuthLifecycleBoundary />
          <ReloadSafetyProvider>
            <WebSocketProvider>
              <ProtectedRoute>
                <PluginsProvider>
                    <SessionStoreProvider>
                      <SessionMessageCacheCoordinator />
                      <Router basename={routerBasename}>
                        <AppRoutes />
                      </Router>
                    </SessionStoreProvider>
                </PluginsProvider>
              </ProtectedRoute>
            </WebSocketProvider>
          </ReloadSafetyProvider>
        </AuthProvider>
      </ThemeProvider>
    </I18nextProvider>
    </ErrorBoundary>
  );
}

function AppRoutes() {
  useEffect(() => { markCloudCliLifecycle('protected-shell-ready'); }, []);
  return useRoutes(appRoutes);
}

function AuthLifecycleBoundary() {
  const { isLoading } = useAuth();
  useEffect(() => { if (!isLoading) markCloudCliLifecycle('auth-ready'); }, [isLoading]);
  return null;
}
