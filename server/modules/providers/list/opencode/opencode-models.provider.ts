import { readFile } from 'node:fs/promises';

import Database from 'better-sqlite3';
import crossSpawn from 'cross-spawn';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  getOpenCodeDatabasePath,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

export const OPENCODE_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'anthropic/claude-sonnet-4-5',
      label: 'Claude Sonnet 4.5',
      description: 'anthropic - anthropic/claude-sonnet-4-5',
    },
    {
      value: 'anthropic/claude-opus-4-1',
      label: 'Claude Opus 4.1',
      description: 'anthropic - anthropic/claude-opus-4-1',
    },
    {
      value: 'anthropic/claude-haiku-4-5',
      label: 'Claude Haiku 4.5',
      description: 'anthropic - anthropic/claude-haiku-4-5',
    },
    {
      value: 'openai/gpt-5.1',
      label: 'GPT-5.1',
      description: 'openai - openai/gpt-5.1',
    },
    {
      value: 'openai/gpt-5.1-codex',
      label: 'GPT-5.1 Codex',
      description: 'openai - openai/gpt-5.1-codex',
    },
    {
      value: 'openai/gpt-5.4-mini',
      label: 'GPT-5.4 Mini',
      description: 'openai - openai/gpt-5.4-mini',
    },
  ],
  DEFAULT: 'anthropic/claude-sonnet-4-5',
};

const OPEN_CODE_MODELS_TIMEOUT_MS = 20_000;
const OPEN_CODE_METADATA_CACHE_TTL_MS = 30_000;
// OpenCode prints one provider/model value per line. Model ids can contain
// additional slashes (for example, some OpenRouter ids), so only validate the
// provider separator and reject whitespace rather than imposing a slug format
// on the upstream provider.
const MODEL_ID_LINE = /^[^\s/][^\s]*\/[^\s]+$/;
// cross-spawn resolves .cmd shims/PATHEXT on Windows and delegates to
// child_process.spawn everywhere else.
const spawnFunction = crossSpawn;
const DATE_TOKEN = /^\d{8}$/;
const SIMPLE_NUMBER_TOKEN = /^\d$/;
const VERSION_TOKEN = /^[a-z]\d+$/i;
const NUMERIC_TOKEN = /^\d+(?:\.\d+)*$/;
const SHORT_ACRONYM_TOKEN = /^[a-z]{2,3}$/;

type OpenCodeVerboseModel = {
  id?: string;
  name?: string;
  providerID?: string;
  variants?: Record<string, unknown>;
  limit?: Record<string, unknown>;
};

export const parseOpenCodeModelsStdout = (stdout: string): string[] => {
  const ids: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('{') || line.startsWith('[')) {
      continue;
    }

    if (MODEL_ID_LINE.test(line)) {
      ids.push(line);
    }
  }

  return [...new Set(ids)];
};

const countJsonBraceDelta = (value: string): number => {
  let delta = 0;
  let inString = false;
  let escaped = false;

  for (const character of value) {
    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === '\\') {
      escaped = inString;
      continue;
    }

    if (character === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (character === '{') {
      delta += 1;
    } else if (character === '}') {
      delta -= 1;
    }
  }

  return delta;
};

const isOpenCodeVerboseModel = (value: unknown): value is OpenCodeVerboseModel => {
  const record = readObjectRecord(value);
  return Boolean(record && readOptionalString(record.id));
};

export const parseOpenCodeVerboseModelsStdout = (stdout: string): OpenCodeVerboseModel[] => {
  const models: OpenCodeVerboseModel[] = [];
  let buffer: string[] = [];
  let depth = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (buffer.length === 0) {
      if (line === '{') {
        buffer = [rawLine];
        depth = 1;
      }
      continue;
    }

    buffer.push(rawLine);
    depth += countJsonBraceDelta(rawLine);

    if (depth !== 0) {
      continue;
    }

    try {
      const parsed = JSON.parse(buffer.join('\n'));
      if (isOpenCodeVerboseModel(parsed)) {
        models.push(parsed);
      }
    } catch {
      // Ignore malformed verbose blocks and fall back to the plain id parser.
    }

    buffer = [];
  }

  return models;
};

const formatDateToken = (token: string): string => (
  `${token.slice(0, 4)}-${token.slice(4, 6)}-${token.slice(6, 8)}`
);

const formatModelToken = (token: string, nextToken?: string): string => {
  const lower = token.toLowerCase();

  if (VERSION_TOKEN.test(token)) {
    return token.toUpperCase();
  }

  if (SHORT_ACRONYM_TOKEN.test(lower) && nextToken && NUMERIC_TOKEN.test(nextToken)) {
    return token.toUpperCase();
  }

  return lower.charAt(0).toUpperCase() + lower.slice(1);
};

const formatOpenCodeModelSlug = (slug: string): string => {
  const labelParts: string[] = [];
  const dateParts: string[] = [];
  const tokens = slug.split('-').filter(Boolean);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const nextToken = tokens[index + 1];

    if (DATE_TOKEN.test(token)) {
      dateParts.push(formatDateToken(token));
      continue;
    }

    if (SIMPLE_NUMBER_TOKEN.test(token) && nextToken && SIMPLE_NUMBER_TOKEN.test(nextToken)) {
      labelParts.push(`${token}.${nextToken}`);
      index += 1;
      continue;
    }

    labelParts.push(formatModelToken(token, nextToken));
  }

  const label = (labelParts.join(' ').trim() || slug).replace(/^GPT\s+/, 'GPT-');
  if (dateParts.length === 0) {
    return label;
  }

  return `${label} (${dateParts.join(', ')})`;
};

const readOpenCodeModelParts = (id: string): { upstreamProvider: string; slug: string } => {
  const separatorIndex = id.indexOf('/');
  if (separatorIndex < 0) {
    return {
      upstreamProvider: '',
      slug: id,
    };
  }

  return {
    upstreamProvider: id.slice(0, separatorIndex),
    slug: id.slice(separatorIndex + 1),
  };
};

const readOpenCodeVerboseModelId = (model: OpenCodeVerboseModel): string | null => {
  const id = readOptionalString(model.id);
  if (!id) {
    return null;
  }

  if (id.includes('/')) {
    return id;
  }

  const upstreamProvider = readOptionalString(model.providerID);
  return upstreamProvider ? `${upstreamProvider}/${id}` : id;
};

const labelForOpenCodeModelId = (id: string): string => {
  const fallbackLabel = OPENCODE_FALLBACK_MODELS.OPTIONS.find((option) => option.value === id)?.label;
  if (fallbackLabel) {
    return fallbackLabel;
  }

  const { slug } = readOpenCodeModelParts(id);
  return formatOpenCodeModelSlug(slug);
};

const descriptionForOpenCodeModelId = (id: string): string => {
  const { upstreamProvider } = readOpenCodeModelParts(id);
  return upstreamProvider ? `${upstreamProvider} - ${id}` : id;
};

const readOpenCodeVariantEffort = (key: string, value: unknown): string | null => {
  const variant = readObjectRecord(value);
  return readOptionalString(variant?.reasoningEffort)
    ?? readOptionalString(variant?.effort)
    ?? key;
};

const readOpenCodeEffortValues = (
  variants: OpenCodeVerboseModel['variants'],
): NonNullable<ProviderModelOption['effort']>['values'] => {
  const effortValues: NonNullable<ProviderModelOption['effort']>['values'] = [];
  const seenValues = new Set<string>();

  for (const [key, value] of Object.entries(variants ?? {})) {
    const effort = readOpenCodeVariantEffort(key, value);
    if (!effort || seenValues.has(effort)) {
      continue;
    }

    seenValues.add(effort);
    effortValues.push({ value: effort });
  }

  return effortValues;
};

const readPositiveContextWindow = (value: unknown): number | undefined => (
  typeof value === 'number'
  && Number.isSafeInteger(value)
  && value > 0
    ? value
    : undefined
);

const readOpenCodeContextWindow = (model: OpenCodeVerboseModel): number | undefined => {
  const limit = readObjectRecord(model.limit);
  return readPositiveContextWindow(limit?.context);
};

const mapOpenCodeVerboseModel = (model: OpenCodeVerboseModel): ProviderModelOption | null => {
  const value = readOpenCodeVerboseModelId(model);
  if (!value) {
    return null;
  }

  const effortValues = readOpenCodeEffortValues(model.variants);
  const contextWindow = readOpenCodeContextWindow(model);

  return {
    value,
    label: readOptionalString(model.name) ?? labelForOpenCodeModelId(value),
    description: descriptionForOpenCodeModelId(value),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(effortValues.length > 0
      ? {
          effort: {
            values: effortValues,
          },
        }
      : {}),
  };
};

const buildOpenCodeOptionFromId = (value: string): ProviderModelOption => ({
  value,
  label: labelForOpenCodeModelId(value),
  description: descriptionForOpenCodeModelId(value),
});

const buildOpenCodeDefinitionFromOptions = (
  options: ProviderModelOption[],
): ProviderModelsDefinition => {
  const uniqueOptions: ProviderModelOption[] = [];
  const seenValues = new Set<string>();

  for (const option of options) {
    if (seenValues.has(option.value)) {
      continue;
    }

    seenValues.add(option.value);
    uniqueOptions.push(option);
  }

  if (uniqueOptions.length === 0) {
    return OPENCODE_FALLBACK_MODELS;
  }

  const defaultValue = uniqueOptions.find((option) => option.value === OPENCODE_FALLBACK_MODELS.DEFAULT)?.value
    ?? uniqueOptions[0].value;

  return {
    OPTIONS: uniqueOptions,
    DEFAULT: defaultValue,
  };
};

export const buildOpenCodeDefinitionFromIds = (ids: string[]): ProviderModelsDefinition => {
  return buildOpenCodeDefinitionFromOptions(ids.map(buildOpenCodeOptionFromId));
};

export const buildOpenCodeDefinitionFromVerboseModels = (
  models: OpenCodeVerboseModel[],
): ProviderModelsDefinition => {
  return buildOpenCodeDefinitionFromOptions(
    models
      .map(mapOpenCodeVerboseModel)
      .filter((model): model is ProviderModelOption => Boolean(model)),
  );
};

const buildOpenCodeDefinitionFromCliOutput = (stdout: string): ProviderModelsDefinition => {
  const ids = parseOpenCodeModelsStdout(stdout);
  const verboseOptions = parseOpenCodeVerboseModelsStdout(stdout)
    .map(mapOpenCodeVerboseModel)
    .filter((model): model is ProviderModelOption => Boolean(model));
  const verboseByValue = new Map(verboseOptions.map((model) => [model.value, model]));
  const options = ids.map((id) => verboseByValue.get(id) ?? buildOpenCodeOptionFromId(id));
  const seenValues = new Set(options.map((option) => option.value));

  // Verbose output may contain metadata for a model without a separate plain
  // id line. Keep those models too so the CLI's complete catalog is retained.
  for (const option of verboseOptions) {
    if (!seenValues.has(option.value)) {
      seenValues.add(option.value);
      options.push(option);
    }
  }

  return buildOpenCodeDefinitionFromOptions(options);
};

export const parseConfiguredOpenCodeModelIds = (
  content: string,
  providerId: string,
): string[] => {
  try {
    const configuration = readObjectRecord(JSON.parse(content));
    const providers = readObjectRecord(configuration?.provider);
    const provider = readObjectRecord(providers?.[providerId]);
    const models = readObjectRecord(provider?.models);
    if (!models) {
      return [];
    }

    return Object.keys(models).map((modelId) => (
      modelId.includes('/') ? modelId : `${providerId}/${modelId}`
    ));
  } catch {
    return [];
  }
};

const loadConfiguredOpenCodeModelIds = async (): Promise<string[]> => {
  const providerId = process.env.CLOUDCLI_OPENCODE_PROVIDER_ID?.trim();
  if (!providerId) {
    return [];
  }

  const inlineConfiguration = process.env.OPENCODE_CONFIG_CONTENT?.trim();
  if (inlineConfiguration) {
    const inlineIds = parseConfiguredOpenCodeModelIds(inlineConfiguration, providerId);
    if (inlineIds.length > 0) {
      return inlineIds;
    }
  }

  const configurationPath = process.env.OPENCODE_CONFIG?.trim();
  if (!configurationPath) {
    return [];
  }

  try {
    return parseConfiguredOpenCodeModelIds(
      await readFile(configurationPath, 'utf8'),
      providerId,
    );
  } catch {
    return [];
  }
};

const parseOpenCodeSessionModelValue = (rawModel: unknown): string | null => {
  if (typeof rawModel === 'string') {
    const trimmed = rawModel.trim();
    if (!trimmed) {
      return null;
    }

    try {
      return parseOpenCodeSessionModelValue(JSON.parse(trimmed));
    } catch {
      return trimmed;
    }
  }

  const record = readObjectRecord(rawModel);
  if (!record) {
    return null;
  }

  return readOptionalString(record.id)
    ?? readOptionalString(record.model)
    ?? readOptionalString(record.name)
    ?? readOptionalString(record.value)
    ?? null;
};

const runOpenCodeModelsCommand = (): Promise<string> => new Promise((resolve, reject) => {
  const configuredProvider = process.env.CLOUDCLI_OPENCODE_PROVIDER_ID?.trim();
  const commandArgs = [
    'models',
    ...(configuredProvider ? [configuredProvider] : []),
    '--verbose',
  ];
  const openCodeProcess = spawnFunction('opencode', commandArgs, {
    cwd: process.cwd(),
    env: { ...process.env },
  });

  let stdout = '';
  let stderr = '';
  let settled = false;

  const timer = setTimeout(() => {
    openCodeProcess.kill('SIGTERM');
    if (!settled) {
      settled = true;
      reject(new Error('opencode models timed out'));
    }
  }, OPEN_CODE_MODELS_TIMEOUT_MS);

  const finish = (error: Error | null, output: string) => {
    if (settled) {
      return;
    }

    settled = true;
    clearTimeout(timer);

    if (error) {
      reject(error);
      return;
    }

    resolve(output);
  };

  openCodeProcess.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  openCodeProcess.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  openCodeProcess.on('error', (error) => {
    finish(error instanceof Error ? error : new Error(String(error)), '');
  });

  openCodeProcess.on('close', (code) => {
    if (code !== 0) {
      finish(new Error(stderr.trim() || `opencode models exited with code ${code}`), '');
      return;
    }

    finish(null, stdout);
  });
});

export class OpenCodeProviderModels implements IProviderModels {
  private pendingModelDiscovery: Promise<ProviderModelsDefinition> | null = null;
  private metadataCache: { definition: ProviderModelsDefinition; expiresAt: number } | null = null;

  constructor(
    private readonly loadModelList = runOpenCodeModelsCommand,
    private readonly loadConfiguredModelIds = loadConfiguredOpenCodeModelIds,
  ) {}

  private discoverModels(): Promise<ProviderModelsDefinition> {
    if (this.pendingModelDiscovery) {
      return this.pendingModelDiscovery;
    }

    const discovery = this.loadModelList()
      .then((stdout) => {
        const definition = buildOpenCodeDefinitionFromCliOutput(stdout);
        this.metadataCache = {
          definition,
          expiresAt: Date.now() + OPEN_CODE_METADATA_CACHE_TTL_MS,
        };
        return definition;
      })
      .finally(() => {
        if (this.pendingModelDiscovery === discovery) {
          this.pendingModelDiscovery = null;
        }
      });

    this.pendingModelDiscovery = discovery;
    return discovery;
  }

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    const configuredIds = await this.loadConfiguredModelIds();
    if (configuredIds.length > 0) {
      return buildOpenCodeDefinitionFromIds(configuredIds);
    }

    try {
      return await this.discoverModels();
    } catch {
      return OPENCODE_FALLBACK_MODELS;
    }
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    // OpenCode's `session` table is keyed by its own session id, so the stable
    // app id has to be translated first; sessions discovered on disk store the
    // provider id in both columns and resolve to themselves.
    const providerSessionId = sessionsDb.getSessionById(sessionId)?.provider_session_id ?? sessionId;

    try {
      const dbPath = getOpenCodeDatabasePath();
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });

      try {
        const row = db.prepare(`
          SELECT
            s.id AS sessionId,
            s.model AS model,
            s.agent AS agent,
            s.directory AS directory,
            s.time_updated AS timeUpdated,
            s.time_created AS timeCreated
          FROM session s
          WHERE s.id = ?
          ORDER BY COALESCE(s.time_updated, s.time_created, 0) DESC
          LIMIT 1
        `).get(providerSessionId) as {
          sessionId?: string;
          model?: unknown;
          agent?: string | null;
          directory?: string | null;
          timeUpdated?: number | null;
          timeCreated?: number | null;
        } | undefined;

        const model = parseOpenCodeSessionModelValue(row?.model);
        if (model) {
          return {
            model,
          };
        }
      } finally {
        db.close();
      }
    } catch {
      // Fall through to the provider default when OpenCode session lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  /**
   * Resolves the discovered context window for the active or resumed OpenCode
   * model selected by the caller. OpenCode model metadata is the source of
   * truth; unknown, invalid, and unavailable limits deliberately return
   * `undefined` so token-usage callers can keep their existing fallback.
   */
  async getContextWindowForModel(modelId: string | null | undefined): Promise<number | undefined> {
    const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
    if (!normalizedModelId) {
      return undefined;
    }

    try {
      const cachedDefinition = this.metadataCache;
      const models = cachedDefinition && cachedDefinition.expiresAt > Date.now()
        ? cachedDefinition.definition
        : await this.discoverModels();
      const option = models.OPTIONS.find((candidate) => candidate.value === normalizedModelId);
      return readPositiveContextWindow(option?.contextWindow);
    } catch {
      // Model discovery is supplemental metadata and must never make a run or
      // usage lookup fail when OpenCode is unavailable or changes its output.
      return undefined;
    }
  }
}
