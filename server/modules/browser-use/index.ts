export { default as browserUseMcpRoutes } from './browser-use-mcp.routes.js';
export { default as browserUseRoutes } from './browser-use.routes.js';
export { browserUseService } from './browser-use.service.js';

/**
 * Lazily starts the Browser Use MCP stdio entrypoint. Keeping this import lazy
 * ensures the entrypoint loads environment configuration before its runtime is
 * evaluated.
 */
export async function startBrowserUseMcp(): Promise<void> {
  await import('./browser-use-mcp.js');
}
