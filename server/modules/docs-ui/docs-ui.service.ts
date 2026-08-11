import { promises as fs } from 'node:fs';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';

import type { Request, Response } from 'express';
import { WebSocket, WebSocketServer } from 'ws';

const PROXY_PREFIX = '/api/docs-ui';
const PROXY_REVISION_PARAM = 'cloudcli-rev';
const PROXY_REVISION = 'docs-runtime-v2';
const OVERLAY_PATH_PREFIX = '/.cloudcli/docs-responsive/';
const OVERLAY_FILES = new Map([['docs-responsive.css', 'text/css; charset=utf-8'], ['docs-responsive.js', 'application/javascript; charset=utf-8']]);
const CONDITIONAL_HEADERS = new Set([
  'if-match', 'if-modified-since', 'if-none-match', 'if-range', 'if-unmodified-since',
]);
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
  'trailer', 'transfer-encoding', 'upgrade', 'host', 'authorization', 'cookie',
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
]);
const RESPONSE_BLOCKED_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
  'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'content-encoding',
  'x-frame-options', 'content-security-policy',
]);
const TRANSFORMED_RESPONSE_BLOCKED_HEADERS = new Set([
  'accept-ranges', 'content-digest', 'content-md5', 'digest', 'etag', 'last-modified',
]);

type DocsUiServiceOptions = {
  upstreamUrl: string;
  credentialsFile: string;
  overlayDirectory: string;
  fetchImpl?: typeof fetch;
  loadAuthorization?: () => Promise<string>;
};

type DocsUiWebSocketOptions = Pick<DocsUiServiceOptions, 'upstreamUrl' | 'credentialsFile' | 'loadAuthorization'> & {
  authenticateToken: (token: string | undefined) => unknown;
  createUpstream?: (url: string, options: { headers: Record<string, string> }) => WebSocket;
};

function rewriteProxyUrl(value: string, upstream: URL): string {
  try {
    const resolved = new URL(value, upstream);
    if (resolved.origin === upstream.origin) {
      return `${PROXY_PREFIX}${resolved.pathname}${resolved.search}${resolved.hash}`;
    }
  } catch {
    return value;
  }
  return value;
}

function rewriteHtml(html: string, upstream: URL): string {
  const rewritten = html
    .replace(/\b(src|href|action)=(['"])\/(?!\/|api\/docs-ui(?:[/?#'" ]|$))/gi, `$1=$2${PROXY_PREFIX}/`)
    .replace(/(['"`])\/(?!api\/docs-ui(?:[/?#'"`]|$))(assets|api)(?=[/?#'"`])/g, `$1${PROXY_PREFIX}/$2`)
    .split(upstream.origin).join(PROXY_PREFIX);
  const revised = rewritten.replace(/\b(src|href)=(['"])([^'"]+)\2/gi, (match, attribute: string, quote: string, value: string) => {
    try {
      const url = new URL(value, 'http://cloudcli.invalid');
      if (!url.pathname.startsWith(`${PROXY_PREFIX}/assets/`) || !/\.(?:m?js)$/i.test(url.pathname)) return match;
      if (!url.searchParams.has(PROXY_REVISION_PARAM)) url.searchParams.set(PROXY_REVISION_PARAM, PROXY_REVISION);
      const revised = `${url.pathname}${url.search}${url.hash}`;
      return `${attribute}=${quote}${revised}${quote}`;
    } catch {
      return match;
    }
  });
  const marker = 'data-cloudcli-docs-responsive';
  if (revised.includes(marker)) return revised;
  const tags = `<link rel="stylesheet" href="${PROXY_PREFIX}${OVERLAY_PATH_PREFIX}docs-responsive.css" ${marker}><script src="${PROXY_PREFIX}${OVERLAY_PATH_PREFIX}docs-responsive.js" ${marker} defer></script>`;
  return /<\/head>/i.test(revised) ? revised.replace(/<\/head>/i, `${tags}</head>`) : `${tags}${revised}`;
}

function rewriteJavaScript(source: string): string {
  return source.replace(/\bwindow\.location\.origin\b(?!\s*\+\s*['"]\/api\/docs-ui['"])/g,
    `(window.location.origin+'${PROXY_PREFIX}')`);
}

async function readBasicAuthorization(credentialsFile: string): Promise<string> {
  const contents = await fs.readFile(credentialsFile, 'utf8');
  const username = contents.match(/^Username:\s*(.+)$/mi)?.[1]?.trim();
  const password = contents.match(/^Password:\s*(.+)$/mi)?.[1]?.trim();
  if (!username || !password) throw new Error('Docs UI credentials are unavailable');
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

/** Creates the fixed-origin Docs UI proxy consumed by the Docs UI router. */
export function createDocsUiService(options: DocsUiServiceOptions) {
  const upstream = new URL(options.upstreamUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const loadAuthorization = options.loadAuthorization
    ?? (() => readBasicAuthorization(options.credentialsFile));

  return async function proxyDocsUi(request: Request, response: Response): Promise<void> {
    try {
      const relativeUrl = request.originalUrl.slice(PROXY_PREFIX.length) || '/';
      if (!relativeUrl.startsWith('/') || relativeUrl.startsWith('//')) throw new Error('Invalid Docs UI path');
      const decodedPath = decodeURIComponent(relativeUrl.split('?')[0]);
      if (decodedPath.split('/').includes('..')) throw new Error('Invalid Docs UI path');
      if (decodedPath.startsWith(OVERLAY_PATH_PREFIX)) {
        const filename = decodedPath.slice(OVERLAY_PATH_PREFIX.length);
        const contentType = OVERLAY_FILES.get(filename);
        if (!contentType || filename.includes('/')) throw new Error('Invalid Docs UI path');
        response.status(200).set({ 'Content-Type': contentType, 'Cache-Control': 'public, max-age=300, immutable', 'X-Content-Type-Options': 'nosniff' });
        response.send(await fs.readFile(path.join(options.overlayDirectory, filename)));
        return;
      }
      const target = new URL(`.${relativeUrl}`, `${upstream.href.replace(/\/$/, '')}/`);
      const upstreamPath = upstream.pathname.endsWith('/') ? upstream.pathname : `${upstream.pathname}/`;
      if (target.origin !== upstream.origin || !target.pathname.startsWith(upstreamPath)) throw new Error('Invalid Docs UI path');

      const headers = new Headers();
      const acceptsTransformedContent = /(?:text\/html|javascript)/i.test(request.headers.accept ?? '');
      const pathRequiresTransformation = /(?:\/|\.(?:html?|m?js))$/i.test(target.pathname)
        || acceptsTransformedContent;
      for (const [name, value] of Object.entries(request.headers)) {
        const lowerName = name.toLowerCase();
        if (HOP_HEADERS.has(lowerName) || (pathRequiresTransformation && CONDITIONAL_HEADERS.has(lowerName))
          || value === undefined) continue;
        headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      headers.set('authorization', await loadAuthorization());

      const hasBody = !['GET', 'HEAD'].includes(request.method);
      const upstreamResponse = await fetchImpl(target, {
        method: request.method,
        headers,
        body: hasBody ? Readable.toWeb(request) as RequestInit['body'] : undefined,
        redirect: 'manual',
        duplex: hasBody ? 'half' : undefined,
      } as RequestInit & { duplex?: 'half' });

      const contentType = upstreamResponse.headers.get('content-type') ?? '';
      const transformsBody = contentType.includes('text/html') || contentType.includes('javascript');
      response.status(upstreamResponse.status);
      upstreamResponse.headers.forEach((value, name) => {
        const lowerName = name.toLowerCase();
        if (RESPONSE_BLOCKED_HEADERS.has(lowerName) || (transformsBody && TRANSFORMED_RESPONSE_BLOCKED_HEADERS.has(lowerName))
          || lowerName === 'set-cookie') return;
        response.setHeader(name, name.toLowerCase() === 'location' ? rewriteProxyUrl(value, upstream) : value);
      });
      for (const cookie of upstreamResponse.headers.getSetCookie?.() ?? []) {
        response.append('Set-Cookie', cookie
          .replace(/;\s*Domain=[^;]+/gi, '')
          .replace(/;\s*Path=([^;]*)/gi, `; Path=${PROXY_PREFIX}/`));
      }
      response.removeHeader('X-Frame-Options');
      response.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
      if (transformsBody) {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Pragma', 'no-cache');
        response.setHeader('Expires', '0');
      }

      if (contentType.includes('text/html')) {
        response.write(rewriteHtml(await upstreamResponse.text(), upstream));
        response.end();
        return;
      }
      if (contentType.includes('javascript')) {
        response.write(rewriteJavaScript(await upstreamResponse.text()));
        response.end();
        return;
      }
      if (!upstreamResponse.body) {
        response.end();
        return;
      }
      Readable.fromWeb(upstreamResponse.body as import('node:stream/web').ReadableStream).pipe(response);
    } catch {
      if (!response.headersSent) {
        response.status(502).json({
          success: false,
          error: { code: 'DOCS_UI_UNAVAILABLE', message: 'Docs UI is unavailable' },
        });
      } else {
        response.end();
      }
    }
  };
}

function getCookie(request: IncomingMessage, name: string): string | undefined {
  return request.headers.cookie?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

/** Creates the fixed-target Docs subscription bridge consumed by server startup. */
export function createDocsUiWebSocketBridge(options: DocsUiWebSocketOptions) {
  const upstream = new URL(options.upstreamUrl);
  upstream.protocol = upstream.protocol === 'https:' ? 'wss:' : 'ws:';
  const target = new URL('./api', `${upstream.href.replace(/\/$/, '')}/`).href;
  const loadAuthorization = options.loadAuthorization
    ?? (() => readBasicAuthorization(options.credentialsFile));
  const createUpstream = options.createUpstream
    ?? ((url: string, init: { headers: Record<string, string> }) => new WebSocket(url, init));
  const server = new WebSocketServer({ noServer: true });

  return async function handleDocsUiUpgrade(
    request: IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ): Promise<boolean> {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname !== `${PROXY_PREFIX}/api`) return false;

    const token = getCookie(request, 'cloudcli-docs-token');
    if (!options.authenticateToken(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }

    let authorization: string;
    try {
      authorization = await loadAuthorization();
    } catch {
      socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }

    server.handleUpgrade(request, socket, head, (client) => {
      const upstreamSocket = createUpstream(target, { headers: { authorization } });
      const pendingFrames: Array<{ data: import('ws').RawData; isBinary: boolean }> = [];
      const closeBoth = () => {
        pendingFrames.length = 0;
        if (client.readyState === WebSocket.OPEN) client.close();
        else if (client.readyState === WebSocket.CONNECTING) client.terminate();
        if (upstreamSocket.readyState === WebSocket.OPEN) upstreamSocket.close();
        else if (upstreamSocket.readyState === WebSocket.CONNECTING) upstreamSocket.terminate();
      };
      client.on('message', (data, isBinary) => {
        if (upstreamSocket.readyState === WebSocket.OPEN) {
          upstreamSocket.send(data, { binary: isBinary });
        } else if (upstreamSocket.readyState === WebSocket.CONNECTING) {
          pendingFrames.push({ data, isBinary });
        }
      });
      upstreamSocket.on('open', () => {
        for (const frame of pendingFrames.splice(0)) {
          upstreamSocket.send(frame.data, { binary: frame.isBinary });
        }
      });
      upstreamSocket.on('message', (data, isBinary) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      });
      client.on('close', closeBoth);
      client.on('error', closeBoth);
      upstreamSocket.on('close', closeBoth);
      upstreamSocket.on('error', closeBoth);
    });
    return true;
  };
}

/** Attaches the path-isolated Docs upgrade contract to CloudCLI's shared HTTP server. */
export function attachDocsUiWebSocketBridge(
  server: HttpServer,
  bridge: ReturnType<typeof createDocsUiWebSocketBridge>,
): void {
  server.on('upgrade', (request, socket, head) => void bridge(request, socket, head));
}
