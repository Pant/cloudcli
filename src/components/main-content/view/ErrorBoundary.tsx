import { useCallback, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { ErrorBoundary as ReactErrorBoundary, type FallbackProps } from 'react-error-boundary';

import { logDiagnostic } from '../../../lib/logger';

import { createDiagnosticId } from './errorBoundary.utils';

export type RecoveryBoundaryProps = { children: ReactNode; area: string; name: string; showDetails?: boolean; onRetry?: () => void; retryLabel?: string; resetKeys?: unknown[]; root?: boolean };

type RecoveryFallbackProps = FallbackProps & Pick<RecoveryBoundaryProps, 'name' | 'showDetails' | 'retryLabel' | 'root'> & { diagnosticId: string; componentStack: string | null };

export function RecoveryFallback({ error, resetErrorBoundary, name, showDetails = false, retryLabel = 'Try again', root = false, diagnosticId, componentStack }: RecoveryFallbackProps) {
  return (
    <div className={root ? 'flex min-h-screen items-center justify-center bg-white p-6 text-gray-950' : 'flex h-full min-h-40 items-center justify-center p-6'} role="alert">
      <div className="w-full max-w-md rounded-lg border border-red-300 bg-red-50 p-6 text-center text-red-950">
        <h2 className="text-base font-semibold">{root ? 'CloudCLI could not start' : `${name} is unavailable`}</h2>
        <p className="mt-2 text-sm">{root ? 'Reload the application to recover safely.' : `The ${name.toLowerCase()} failed without affecting the rest of the application.`}</p>
        <p className="mt-2 font-mono text-xs">Diagnostic ID: {diagnosticId}</p>
        {showDetails && (root || import.meta.env?.DEV || import.meta.env?.MODE === 'test') && <details className="mt-3 text-left text-xs"><summary className="cursor-pointer">Error details</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-red-100 p-2">{error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown render error'}{componentStack}</pre></details>}
        <button type="button" onClick={resetErrorBoundary} className="mt-4 rounded bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-500">{retryLabel}</button>
      </div>
    </div>
  );
}

export default function ErrorBoundary({ children, area, name, showDetails = false, onRetry, retryLabel, resetKeys, root = false }: RecoveryBoundaryProps) {
  const diagnosticIdRef = useRef(createDiagnosticId());
  const [componentStack, setComponentStack] = useState<string | null>(null);
  const handleError = useCallback((error: unknown, errorInfo: ErrorInfo) => {
    setComponentStack(errorInfo.componentStack ?? null);
    logDiagnostic({ level: 'error', area: 'error_boundary', event: 'render_error', outcome: 'isolated', code: diagnosticIdRef.current, metadata: { boundaryArea: area, boundaryName: name, errorName: error instanceof Error ? error.name : typeof error, errorMessage: error instanceof Error ? error.message : 'Unknown render error' } });
  }, [area, name]);
  const handleReset = useCallback(() => { setComponentStack(null); diagnosticIdRef.current = createDiagnosticId(); onRetry?.(); }, [onRetry]);
  return <ReactErrorBoundary fallbackRender={(props) => <RecoveryFallback {...props} name={name} showDetails={showDetails} retryLabel={retryLabel} root={root} diagnosticId={diagnosticIdRef.current} componentStack={componentStack} />} onError={handleError} onReset={handleReset} resetKeys={resetKeys}>{children}</ReactErrorBoundary>;
}
