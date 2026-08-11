import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';

import { Button } from '../../../shared/view/ui';
import { logDiagnostic } from '../../../lib/logger';
import { initializeDocsUiSession } from '../docsUiApi';

const DOCS_RENDER_TIMEOUT_MS = 3_000;

type DocsDiagnostic = Parameters<typeof logDiagnostic>[0];

const emitDocsDiagnostic = (diagnostic: DocsDiagnostic) => {
  logDiagnostic(diagnostic);
  const message = `[DocsUI] ${JSON.stringify(diagnostic)}`;
  if (diagnostic.level === 'error') console.error(message);
  else if (diagnostic.level === 'warn') console.warn(message);
  else console.info(message);
};

export default function DocsUiPanel() {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [iframeKey, setIframeKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const recoveryAttemptedRef = useRef(false);

  useEffect(() => {
    emitDocsDiagnostic({ level: 'info', area: 'docs_ui', event: 'session_initialization_started' });
    void initializeDocsUiSession()
      .then((response) => {
        emitDocsDiagnostic({
          level: response.ok ? 'info' : 'error',
          area: 'docs_ui',
          event: response.ok ? 'session_initialization_succeeded' : 'session_initialization_failed',
          outcome: response.ok ? 'ready' : 'failure',
          code: response.ok ? undefined : `HTTP_${response.status}`,
          metadata: { status: response.status },
        });
        setReady(response.ok);
        setFailed(!response.ok);
      })
      .catch((error: unknown) => {
        emitDocsDiagnostic({
          level: 'error',
          area: 'docs_ui',
          event: 'session_initialization_failed',
          outcome: 'failure',
          code: 'NETWORK_ERROR',
          metadata: { error },
        });
        setFailed(true);
      });
  }, []);

  const handleIframeLoad = (event: React.SyntheticEvent<HTMLIFrameElement>) => {
    const iframe = event.currentTarget;
    const loadedIframeKey = iframeKey;
    const documentState = iframe?.contentDocument?.readyState ?? 'unavailable';
    emitDocsDiagnostic({
      level: 'info',
      area: 'docs_ui',
      event: 'iframe_loaded',
      outcome: 'loaded',
      metadata: { iframeKey: loadedIframeKey, documentState },
    });

    window.setTimeout(() => {
      if (iframeRef.current !== iframe) {
        emitDocsDiagnostic({
          level: 'debug',
          area: 'docs_ui',
          event: 'iframe_render_check_skipped',
          outcome: 'stale_iframe',
          metadata: { iframeKey: loadedIframeKey },
        });
        return;
      }

      const root = iframe.contentDocument?.getElementById('root');
      if (!root) {
        emitDocsDiagnostic({
          level: 'error',
          area: 'docs_ui',
          event: 'iframe_root_missing',
          outcome: 'failure',
          code: 'DOCS_ROOT_MISSING',
          metadata: { iframeKey: loadedIframeKey },
        });
        return;
      }
      const visibleTextLength = root.innerText.trim().length;
      const rootRectangle = root.getBoundingClientRect();
      const hasVisibleContent = root.childElementCount > 0
        && visibleTextLength > 0
        && rootRectangle.width > 0
        && rootRectangle.height > 0;
      if (hasVisibleContent) {
        const iframeRectangle = iframe.getBoundingClientRect();
        const rootStyle = iframe.contentWindow?.getComputedStyle(root);
        const centerElement = document.elementFromPoint(
          iframeRectangle.left + (iframeRectangle.width / 2),
          iframeRectangle.top + (iframeRectangle.height / 2),
        );
        emitDocsDiagnostic({
          level: 'info',
          area: 'docs_ui',
          event: 'iframe_render_confirmed',
          outcome: 'rendered',
          metadata: {
            iframeKey: loadedIframeKey,
            childElementCount: root.childElementCount,
            visibleTextLength,
            iframeWidth: Math.round(iframeRectangle.width),
            iframeHeight: Math.round(iframeRectangle.height),
            rootWidth: Math.round(rootRectangle.width),
            rootHeight: Math.round(rootRectangle.height),
            rootDisplay: rootStyle?.display,
            rootVisibility: rootStyle?.visibility,
            rootOpacity: rootStyle?.opacity,
            iframeAtCenter: centerElement === iframe,
            centerElementTag: centerElement?.tagName,
          },
        });
        return;
      }
      if (recoveryAttemptedRef.current) {
        emitDocsDiagnostic({
          level: 'error',
          area: 'docs_ui',
          event: 'iframe_render_recovery_failed',
          outcome: 'failure',
          code: 'DOCS_ROOT_EMPTY',
          metadata: {
            iframeKey: loadedIframeKey,
            childElementCount: root.childElementCount,
            visibleTextLength,
            rootWidth: Math.round(rootRectangle.width),
            rootHeight: Math.round(rootRectangle.height),
          },
        });
        return;
      }

      // A cached or interrupted module load can leave the upstream shell empty.
      // Remount once so users do not remain on a blank Docs panel indefinitely.
      emitDocsDiagnostic({
        level: 'warn',
        area: 'docs_ui',
        event: 'iframe_render_recovery_started',
        outcome: 'retrying',
        code: 'DOCS_ROOT_EMPTY',
        metadata: {
          iframeKey: loadedIframeKey,
          childElementCount: root.childElementCount,
          visibleTextLength,
          rootWidth: Math.round(rootRectangle.width),
          rootHeight: Math.round(rootRectangle.height),
        },
      });
      recoveryAttemptedRef.current = true;
      setIframeKey((currentKey) => currentKey + 1);
    }, DOCS_RENDER_TIMEOUT_MS);
  };

  const refreshIframe = () => {
    emitDocsDiagnostic({
      level: 'info',
      area: 'docs_ui',
      event: 'manual_refresh_requested',
      outcome: 'refreshing',
      metadata: { iframeKey },
    });
    recoveryAttemptedRef.current = false;
    setIframeKey((currentKey) => currentKey + 1);
  };

  if (failed) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Docs UI is unavailable.</div>;
  }
  if (!ready) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading Docs…</div>;
  }
  return (
    <div className="relative h-full w-full">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="absolute right-3 top-3 z-10 h-8 gap-1.5 shadow-sm"
        onClick={refreshIframe}
        aria-label="Refresh Docs"
        title="Refresh Docs"
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        Refresh
      </Button>
      <iframe
        key={iframeKey}
        ref={iframeRef}
        title="Docs"
        src="/api/docs-ui/"
        onLoad={handleIframeLoad}
        className="h-full w-full border-0 bg-background"
        sandbox="allow-forms allow-modals allow-popups allow-scripts allow-same-origin allow-downloads"
      />
    </div>
  );
}
