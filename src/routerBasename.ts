const DEPLOYMENT_ASSET_DIRECTORIES = new Set(['assets', 'static', 'icons', 'images']);

export type RouterBasenameHint = {
  kind: 'manifest' | 'script' | 'icon';
  value: string;
};

function basenameFromHint(hint: RouterBasenameHint, baseUrl: string, origin: string) {
  const candidateUrl = new URL(hint.value, baseUrl);
  if (candidateUrl.origin !== origin) return null;

  const pathname = candidateUrl.pathname.replace(/\/+$/, '');
  if (hint.kind === 'script') {
    const match = pathname.match(/^(.*)\/assets\//);
    return match ? (match[1] || '').replace(/\/+$/, '') : null;
  }

  const match = hint.kind === 'manifest'
    ? pathname.match(/^(.*)\/(?:manifest\.json|site\.webmanifest)$/)
    : pathname.match(/^(.*)\/(?:favicon(?:\.[^/]+)?|apple-touch-icon(?:-[^/]+)?(?:\.[^/]+)?|mask-icon(?:\.[^/]+)?|[^/]*icon[^/]*)$/);
  if (!match) return null;

  const segments = (match[1] || '').split('/').filter(Boolean);
  while (segments.length > 0 && DEPLOYMENT_ASSET_DIRECTORIES.has(segments[segments.length - 1])) {
    segments.pop();
  }
  return segments.length > 0 ? `/${segments.join('/')}` : '';
}

export function inferRouterBasename({
  explicitBasename = '',
  baseUrl,
  origin,
  hints,
}: {
  explicitBasename?: string;
  baseUrl: string;
  origin: string;
  hints: RouterBasenameHint[];
}) {
  if (explicitBasename) return explicitBasename.replace(/\/+$/, '');

  const hintTiers: RouterBasenameHint['kind'][][] = [['manifest', 'script'], ['icon']];
  for (const kinds of hintTiers) {
    let detected: string | null = null;
    for (const hint of hints) {
      if (!kinds.includes(hint.kind)) continue;
      try {
        const candidate = basenameFromHint(hint, baseUrl, origin);
        if (candidate !== null && (detected === null || candidate.length > detected.length)) detected = candidate;
      } catch {
        // Ignore invalid candidate URLs and continue checking other hints.
      }
    }
    if (detected !== null) return detected;
  }

  return '';
}
