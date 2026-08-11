import { Router } from 'express';

/** Creates the thin catch-all router used by the Docs UI module. */
export function createDocsUiRouter(proxyDocsUi: import('express').RequestHandler): Router {
  const router = Router();
  router.post('/session', (request, response) => {
    const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) {
      response.status(401).json({ success: false, error: { code: 'AUTH_TOKEN_INVALID', message: 'Authentication required' } });
      return;
    }
    response.setHeader('Set-Cookie', `cloudcli-docs-token=${token}; Path=/api/docs-ui/; HttpOnly; SameSite=Strict`);
    response.status(204).end();
  });
  router.all('/{*docsPath}', proxyDocsUi);
  router.all('/', proxyDocsUi);
  return router;
}
