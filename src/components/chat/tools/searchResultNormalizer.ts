/**
 * The result payloads produced by search tools differ between providers. This
 * module deliberately knows nothing about a provider: it accepts the complete
 * tool result and turns the search-shaped parts into the small data contract
 * needed by the file-list renderer.
 */

export interface NormalizedSearchToolResult {
  files: string[];
  count: number;
}

const COUNT_KEYS = new Set([
  'count',
  'fileCount',
  'file_count',
  'numFiles',
  'num_files',
  'totalFiles',
  'total_files',
]);

const PATH_KEYS = new Set([
  'file',
  'fileName',
  'file_name',
  'filename',
  'filePath',
  'file_path',
  'path',
]);

const NESTED_PATH_KEYS = new Set([
  'file',
  'fileName',
  'file_name',
  'filename',
  'filePath',
  'file_path',
  'name',
  'path',
]);

const CONTAINER_KEYS = new Set([
  'files',
  'filenames',
  'matches',
  'paths',
  'results',
]);

const IGNORED_TEXT_LINE = /^(?:found(?:\s|:|$)|no\s+(?:files?|matches?|results?)\b|total(?:\s|:|$)|results?(?:\s|:|$)|matches?(?:\s|:|$)|search(?:\s|:|$)|status(?:\s|:|$)|warning(?:\s|:|$)|error(?:\s|:|$)|diagnostic(?:\s|:|$)|scanning(?:\s|:|$)|searching(?:\s|:|$)|processing(?:\s|:|$)|reading(?:\s|:|$)|loading(?:\s|:|$)|starting(?:\s|:|$)|finished(?:\s|:|$)|completed?(?:\s|:|$)|done(?:\s|:|$)|success(?:fully)?(?:\s|:|$)|failed?(?:\s|:|$)|failure(?:\s|:|$)|ok(?:\s|:|$)|showing\s+\d+\b|\d+\s+(?:matching\s+)?files?\s+(?:found|matched)\b)/i;

const IGNORED_TEXT_CONTENT = /^(?:truncated(?:\s|:|$)|omitted(?:\s|:|$)|output\s+(?:was\s+)?(?:limited|truncated)\b|(?:too\s+many|more)\s+(?:files?|matches?)\b|limit\s+(?:was\s+)?reached\b|(?:some|additional|remaining)\s+(?:files?|matches?).*\b(?:omitted|truncated)\b)/i;

const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const MAX_DEPTH = 100;

type RecordValue = Record<string, unknown>;
type CountSource = 'metadata' | 'content';

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readKeys(value: RecordValue): string[] {
  try {
    return Object.keys(value);
  } catch {
    return [];
  }
}

function readValue(value: RecordValue, key: string): unknown {
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function parseCount(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0
      ? value
      : undefined;
  }

  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function stripWrappingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '`' && last === '`') || (first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function cleanPath(value: string): string | undefined {
  const cleaned = stripWrappingQuotes(value.replace(ANSI_ESCAPE, '').trim());
  if (!cleaned || cleaned.length > 4096 || /[\r\n\u0000]/.test(cleaned)) return undefined;
  if (cleaned.startsWith('{') || cleaned.startsWith('[') || /^\w+:\/\//.test(cleaned)) return undefined;
  return cleaned;
}

function looksLikePath(value: string, allowBareName = false): boolean {
  if (!value || /[<>]/.test(value) || /\s{2,}/.test(value)) return false;
  if (/^(?:\/|\.\.?\/|~\/|[A-Za-z]:[\\/])/.test(value)) return true;
  if (value.includes('/') || value.includes('\\')) return true;
  if (/\.[^./\\\s]{1,40}$/.test(value)) return true;
  return allowBareName && /^[A-Za-z0-9_.@-]+$/.test(value);
}

function isIgnoredTextLine(value: string): boolean {
  const line = value.trim();
  if (!line) return true;
  if (IGNORED_TEXT_LINE.test(line) || IGNORED_TEXT_CONTENT.test(line)) return true;
  if (/^(?:[-*•]\s+)?(?:\[?(?:info|debug|warn|error|status)\]?\s*[:\]])/i.test(line)) return true;
  if (/^(?:\.{3,}|[-=]{3,})$/.test(line)) return true;
  return false;
}

/** Extracts `path` from common grep output such as `path:12:match`. */
function parseGrepPath(value: string): string | undefined {
  const line = value.trim();
  if (isIgnoredTextLine(line)) return undefined;

  const match = line.match(/^(.+?):\s*(?:line\s+)?\d+(?:\s*-\s*\d+)?(?:\s*[:\-]\s*.*)?$/i);
  if (!match?.[1]) return undefined;

  const candidate = cleanPath(match[1]);
  return candidate && looksLikePath(candidate, true) ? candidate : undefined;
}

function parseJson(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('[') && !trimmed.startsWith('"'))) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function isSearchKey(key: string): boolean {
  return COUNT_KEYS.has(key) || PATH_KEYS.has(key) || CONTAINER_KEYS.has(key);
}

/**
 * Normalize a provider's complete search tool result.
 *
 * Structured metadata is visited before content, and structured content is
 * visited before its textual representation. The ordering matters because it
 * keeps the first-seen path ordering stable while allowing a provider's
 * explicit total to describe a truncated visible file list.
 */
export function normalizeSearchToolResult(value: unknown): NormalizedSearchToolResult {
  const files: string[] = [];
  const seenFiles = new Set<string>();
  const explicitCounts: Record<CountSource, number[]> = {
    metadata: [],
    content: [],
  };

  const addFile = (valueToAdd: string, trusted = false): void => {
    const cleaned = cleanPath(valueToAdd);
    if (!cleaned) return;
    if (!looksLikePath(cleaned, trusted)) return;
    if (isIgnoredTextLine(cleaned)) return;
    if (seenFiles.has(cleaned)) return;
    seenFiles.add(cleaned);
    files.push(cleaned);
  };

  const addTextLine = (valueToAdd: string, trusted = false, source: CountSource = 'content'): void => {
    let line = valueToAdd.replace(ANSI_ESCAPE, '').trim();
    if (!line) return;
    line = line.replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, '').trim();
    line = stripWrappingQuotes(line);
    collectTextCount(line, source);
    if (isIgnoredTextLine(line)) return;

    const grepPath = parseGrepPath(line);
    if (grepPath) {
      addFile(grepPath, true);
      return;
    }

    const candidate = cleanPath(line);
    if (candidate && (trusted || looksLikePath(candidate))) addFile(candidate, trusted);
  };

  const collectTextCount = (line: string, source: CountSource): void => {
    const countMatch = line.match(/\b(?:found|located|matched)\s+(?:(?:\d+)\s+matches?\s+in\s+)?(\d+)\s+(?:matching\s+)?files?\b/i)
      ?? line.match(/\b(\d+)\s+(?:matching\s+)?files?\s+(?:found|matched)\b/i)
      ?? line.match(/\bfiles?\s*[:=]\s*(\d+)\b/i);
    if (!countMatch?.[1]) return;
    const count = parseCount(countMatch[1]);
    if (count !== undefined) explicitCounts[source].push(count);
  };

  const addText = (text: string, trusted = false, source: CountSource = 'content'): void => {
    for (const line of text.split(/\r?\n/)) addTextLine(line, trusted, source);
  };

  const collectStructured = (
    structured: unknown,
    depth: number,
    inheritedContainer = false,
    source: CountSource = 'content',
  ): void => {
    if (depth > MAX_DEPTH || structured === null || structured === undefined) return;

    if (typeof structured === 'string') {
      const parsed = parseJson(structured);
      if (parsed !== undefined && parsed !== structured) {
        collectStructured(parsed, depth + 1, inheritedContainer, source);
      } else {
        addText(structured, inheritedContainer, source);
      }
      return;
    }

    if (Array.isArray(structured)) {
      for (const item of structured) collectStructured(item, depth + 1, true, source);
      return;
    }

    if (!isRecord(structured)) return;

    let keys: string[];
    try {
      if (visitedObjects.has(structured)) return;
      visitedObjects.add(structured);
      keys = readKeys(structured);
    } catch {
      return;
    }

    for (const key of keys) {
      const child = readValue(structured, key);
      if (COUNT_KEYS.has(key)) {
        const count = parseCount(child);
        if (count !== undefined) explicitCounts[source].push(count);
        continue;
      }

      if (PATH_KEYS.has(key) || (inheritedContainer && NESTED_PATH_KEYS.has(key))) {
        collectPathValue(child, depth + 1, source);
        continue;
      }

      if (inheritedContainer && typeof key === 'string') {
        const mapPath = cleanPath(key);
        if (mapPath && looksLikePath(mapPath)) addFile(mapPath, true);
      }

      collectStructured(child, depth + 1, CONTAINER_KEYS.has(key), source);
    }
  };

  const visitedObjects = new WeakSet<object>();

  const collectPathValue = (pathValue: unknown, depth: number, source: CountSource): void => {
    if (depth > MAX_DEPTH || pathValue === null || pathValue === undefined) return;
    if (typeof pathValue === 'string') {
      const parsed = parseJson(pathValue);
      if (parsed !== undefined && parsed !== pathValue) {
        collectStructured(parsed, depth + 1, true, source);
        return;
      }
      addText(pathValue, true, source);
      return;
    }
    if (Array.isArray(pathValue)) {
      for (const item of pathValue) collectPathValue(item, depth + 1, source);
      return;
    }
    collectStructured(pathValue, depth + 1, true, source);
  };

  const collectContent = (content: unknown): void => {
    if (typeof content === 'string') {
      const parsed = parseJson(content);
      if (parsed !== undefined && parsed !== content) {
        collectStructured(parsed, 0, false, 'content');
      } else {
        addText(content, false, 'content');
      }
      return;
    }
    collectStructured(content, 0, false, 'content');
  };

  try {
    if (isRecord(value)) {
      const toolUseResult = readValue(value, 'toolUseResult');
      const hasToolUseResult = readKeys(value).includes('toolUseResult');
      if (hasToolUseResult) {
        collectStructured(toolUseResult, 0, false, 'metadata');
      } else if (readKeys(value).some(isSearchKey)) {
        collectStructured(value, 0, false, 'content');
      }

      const content = readValue(value, 'content');
      if (readKeys(value).includes('content')) collectContent(content);
    } else {
      collectContent(value);
    }
  } catch {
    // A malformed provider payload should never break chat rendering. Any
    // paths collected before an unusual getter/proxy failed remain usable.
  }

  const metadataCount = explicitCounts.metadata.length > 0 ? Math.max(...explicitCounts.metadata) : undefined;
  const contentCount = explicitCounts.content.length > 0 ? Math.max(...explicitCounts.content) : 0;
  const largestExplicitCount = metadataCount ?? contentCount;
  return {
    files,
    count: Math.max(files.length, largestExplicitCount),
  };
}
