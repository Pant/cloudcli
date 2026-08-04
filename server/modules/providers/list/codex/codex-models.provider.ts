import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';
import crossSpawn from 'cross-spawn';

import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

const EXTENDED_REASONING_LEVELS = [
  { value: 'low' },
  { value: 'medium' },
  { value: 'high' },
  { value: 'xhigh' },
  { value: 'max' },
  { value: 'ultra' },
];

const CLOUDCLI_CODEX_MODELS: ProviderModelOption[] = [
  {
    value: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    description: 'GPT-5.6 Sol',
    effort: {
      default: 'low',
      values: EXTENDED_REASONING_LEVELS,
    },
  },
  {
    value: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    description: 'GPT-5.6 Terra',
    effort: {
      default: 'medium',
      values: EXTENDED_REASONING_LEVELS,
    },
  },
  {
    value: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    description: 'GPT-5.6 Luna',
    effort: {
      default: 'medium',
      values: EXTENDED_REASONING_LEVELS,
    },
  },
];

// Codex model tests verify this catalog remains usable when the CLI cache is missing.
export const CODEX_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    ...CLOUDCLI_CODEX_MODELS,
    {
      value: 'gpt-5.5',
      label: 'gpt-5.5',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'gpt-5.4',
      label: 'gpt-5.4',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'gpt-5.4-mini',
      label: 'gpt-5.4-mini',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
  ],
  DEFAULT: 'gpt-5.6-sol',
};

type CodexCachedModel = {
  slug?: string;
  display_name?: string;
  description?: string;
  priority?: number;
  visibility?: string;
  supported_in_api?: boolean;
  default_reasoning_level?: string;
  supported_reasoning_levels?: Array<{
    effort?: string;
    description?: string;
  }>;
};

type CodexAppServerModel = {
  id?: string;
  model?: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{
    reasoningEffort?: string;
    description?: string;
  }>;
};

const CODEX_MODELS_CACHE_PATH = path.join(os.homedir(), '.codex', 'models_cache.json');
const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');
const CODEX_MODEL_LIST_TIMEOUT_MS = 15_000;
const CODEX_INITIALIZE_REQUEST_ID = 1;
const CODEX_MODEL_LIST_REQUEST_ID = 2;

const isCodexCachedModel = (value: unknown): value is CodexCachedModel => {
  const record = readObjectRecord(value);
  return Boolean(record && readOptionalString(record.slug));
};

const readCodexPriority = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER
);

const mapCodexModel = (model: CodexCachedModel): ProviderModelOption => {
  const effortValues = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels
      .map((level) => {
        const value = readOptionalString(level?.effort);
        if (!value) {
          return null;
        }

        return {
          value,
          description: readOptionalString(level?.description),
        };
      })
      .filter((level): level is NonNullable<typeof level> => Boolean(level))
    : [];

  return {
    value: model.slug as string,
    label: readOptionalString(model.display_name) ?? (model.slug as string),
    description: readOptionalString(model.description),
    effort: effortValues.length > 0
      ? {
          default: readOptionalString(model.default_reasoning_level) ?? undefined,
          values: effortValues,
        }
      : undefined,
  };
};

const isCodexAppServerModel = (value: unknown): value is CodexAppServerModel => {
  const record = readObjectRecord(value);
  return Boolean(record && (readOptionalString(record.id) ?? readOptionalString(record.model)));
};

const mapCodexAppServerModel = (model: CodexAppServerModel): ProviderModelOption | null => {
  const value = readOptionalString(model.model) ?? readOptionalString(model.id);
  if (!value || model.hidden === true) {
    return null;
  }

  const effortValues = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts
      .map((level) => {
        const effort = readOptionalString(level?.reasoningEffort);
        if (!effort) {
          return null;
        }

        return {
          value: effort,
          description: readOptionalString(level?.description),
        };
      })
      .filter((level): level is NonNullable<typeof level> => Boolean(level))
    : [];

  return {
    value,
    label: readOptionalString(model.displayName) ?? value,
    description: readOptionalString(model.description),
    effort: effortValues.length > 0
      ? {
          default: readOptionalString(model.defaultReasoningEffort) ?? undefined,
          values: effortValues,
        }
      : undefined,
  };
};

const buildCodexAppServerModelsDefinition = (
  models: CodexAppServerModel[],
): ProviderModelsDefinition | null => {
  const options: ProviderModelOption[] = [];
  const seenValues = new Set<string>();

  for (const model of models) {
    const option = mapCodexAppServerModel(model);
    if (!option || seenValues.has(option.value)) {
      continue;
    }

    seenValues.add(option.value);
    options.push(option);
  }

  if (options.length === 0) {
    return null;
  }

  const advertisedDefault = models.find((model) => model.isDefault === true);
  const defaultValue = readOptionalString(advertisedDefault?.model)
    ?? readOptionalString(advertisedDefault?.id);

  return {
    OPTIONS: options,
    DEFAULT: defaultValue && seenValues.has(defaultValue) ? defaultValue : options[0].value,
  };
};

const buildCodexModelsDefinition = (models: CodexCachedModel[]): ProviderModelsDefinition => {
  const sortedModels = [...models]
    .filter((model) => model.visibility === 'list' && model.supported_in_api !== false)
    .sort((left, right) => readCodexPriority(left.priority) - readCodexPriority(right.priority));

  const cachedOptions: ProviderModelOption[] = [];
  const seenValues = new Set<string>();

  for (const model of sortedModels) {
    const mappedModel = mapCodexModel(model);
    if (seenValues.has(mappedModel.value)) {
      continue;
    }

    seenValues.add(mappedModel.value);
    cachedOptions.push(mappedModel);
  }

  if (cachedOptions.length === 0) {
    return CODEX_FALLBACK_MODELS;
  }

  return {
    OPTIONS: cachedOptions,
    DEFAULT: cachedOptions[0]?.value ?? CODEX_FALLBACK_MODELS.DEFAULT,
  };
};

const runCodexModelList = (): Promise<CodexAppServerModel[]> => new Promise((resolve, reject) => {
  const codexProcess = crossSpawn('codex', ['app-server', '--stdio'], {
    cwd: process.cwd(),
    env: { ...process.env },
  });

  let stdoutBuffer = '';
  let stderr = '';
  let settled = false;
  let initialized = false;

  const finish = (error: Error | null, models: CodexAppServerModel[] = []) => {
    if (settled) {
      return;
    }

    settled = true;
    clearTimeout(timer);
    codexProcess.kill('SIGTERM');

    if (error) {
      reject(error);
      return;
    }

    resolve(models);
  };

  const timer = setTimeout(() => {
    finish(new Error('codex model/list timed out'));
  }, CODEX_MODEL_LIST_TIMEOUT_MS);

  const writeMessage = (message: Record<string, unknown>) => {
    codexProcess.stdin?.write(`${JSON.stringify(message)}\n`);
  };

  writeMessage({
    id: CODEX_INITIALIZE_REQUEST_ID,
    method: 'initialize',
    params: {
      clientInfo: {
        name: 'cloudcli-model-discovery',
        version: '1.0.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    },
  });

  codexProcess.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      let message: Record<string, unknown> | null = null;
      try {
        message = readObjectRecord(JSON.parse(line));
      } catch {
        continue;
      }

      if (!message) {
        continue;
      }

      if (message.id === CODEX_INITIALIZE_REQUEST_ID && !initialized) {
        initialized = true;
        writeMessage({ method: 'initialized' });
        writeMessage({
          id: CODEX_MODEL_LIST_REQUEST_ID,
          method: 'model/list',
          params: {
            limit: 100,
            includeHidden: false,
          },
        });
        continue;
      }

      if (message.id !== CODEX_MODEL_LIST_REQUEST_ID) {
        continue;
      }

      const error = readObjectRecord(message.error);
      if (error) {
        finish(new Error(readOptionalString(error.message) ?? 'codex model/list failed'));
        return;
      }

      const result = readObjectRecord(message.result);
      const models = Array.isArray(result?.data)
        ? result.data.filter(isCodexAppServerModel)
        : [];

      finish(models.length > 0 ? null : new Error('codex model/list returned no models'), models);
      return;
    }
  });

  codexProcess.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  codexProcess.on('error', (error) => {
    finish(error instanceof Error ? error : new Error(String(error)));
  });

  codexProcess.on('close', (code) => {
    if (!settled) {
      finish(new Error(stderr.trim() || `codex app-server exited with code ${code}`));
    }
  });
});

// CodexProvider consumes this adapter to expose the CLI's model catalog and active model.
export class CodexProviderModels implements IProviderModels {
  constructor(
    private readonly modelsCachePath = CODEX_MODELS_CACHE_PATH,
    private readonly configPath = CODEX_CONFIG_PATH,
    private readonly loadDynamicModels = runCodexModelList,
  ) {}

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    try {
      const dynamicModels = buildCodexAppServerModelsDefinition(await this.loadDynamicModels());
      if (dynamicModels) {
        return dynamicModels;
      }
    } catch {
      // The local CLI cache remains available when app-server discovery is offline or unavailable.
    }

    try {
      const raw = await readFile(this.modelsCachePath, 'utf8');
      const parsed = readObjectRecord(JSON.parse(raw));
      const models = Array.isArray(parsed?.models)
        ? parsed.models.filter(isCodexCachedModel)
        : [];

      return buildCodexModelsDefinition(models);
    } catch {
      return CODEX_FALLBACK_MODELS;
    }
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    try {
      const raw = await readFile(this.configPath, 'utf8');
      const parsed = readObjectRecord(TOML.parse(raw));
      const model = readOptionalString(parsed?.model);
      if (!model) {
        return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
      }

      return {
        model,
      };
    } catch {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }
  }
}
