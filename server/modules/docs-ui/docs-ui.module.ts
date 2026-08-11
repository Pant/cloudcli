import { createDocsUiRouter } from './docs-ui.routes.js';
import { createDocsUiService, createDocsUiWebSocketBridge } from './docs-ui.service.js';

const upstreamUrl = process.env.DOCS_MCP_WEB_URL ?? 'http://127.0.0.1:8080';
const credentialsFile = process.env.DOCS_MCP_CREDENTIALS_FILE ?? 'basic-auth-credentials.txt';
const overlayDirectory = process.env.DOCS_MCP_OVERLAY_DIRECTORY
  ?? new URL('../../../../docs_mcp_server/overlay/', import.meta.url).pathname;

const proxyDocsUi = createDocsUiService({
  upstreamUrl,
  credentialsFile,
  overlayDirectory,
});

/** Fixed-config Docs websocket bridge constructed for the server entrypoint. */
export function createConfiguredDocsUiWebSocketBridge(authenticateToken: (token: string | undefined) => unknown) {
  return createDocsUiWebSocketBridge({
    upstreamUrl,
    credentialsFile,
    authenticateToken,
  });
}

/** Router consumed by the server entrypoint for the protected Docs UI proxy. */
export const docsUiRoutes = createDocsUiRouter((request, response, next) => {
  void proxyDocsUi(request, response).catch(next);
});
