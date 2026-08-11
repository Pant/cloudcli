// docsUiRoutes: used by the server entrypoint to mount the authenticated fixed-origin Docs UI proxy.
export { docsUiRoutes } from './docs-ui.module.js';
// Server startup uses these contracts to attach the fixed-target Docs subscription bridge.
export { createConfiguredDocsUiWebSocketBridge } from './docs-ui.module.js';
export { attachDocsUiWebSocketBridge } from './docs-ui.service.js';
