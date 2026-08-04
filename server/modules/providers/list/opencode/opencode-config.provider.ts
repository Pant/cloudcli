import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { McpScope } from '@/shared/types.js';
import { readObjectRecord } from '@/shared/utils.js';

type OpenCodeConfigStoreOptions = {
  userConfigDirectory?: string;
};

type OpenCodeConfigPath = {
  filePath: string;
  exists: boolean;
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

// Removes JSONC comments without touching comment-like text inside strings.
const stripJsonComments = (content: string): string => {
  let output = '';
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = '';
      }
      continue;
    }

    if (char === '"' || char === '\'') {
      inString = true;
      quote = char;
      output += char;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < content.length && content[index] !== '\n') {
        index += 1;
      }
      output += '\n';
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index < content.length && !(content[index] === '*' && content[index + 1] === '/')) {
        index += 1;
      }
      index += 1;
      continue;
    }

    output += char;
  }

  return output;
};

const stripTrailingCommas = (content: string): string => content.replace(/,\s*([}\]])/g, '$1');

/**
 * Synchronized reader/writer for OpenCode's user and project JSON/JSONC files.
 *
 * OpenCode's MCP and agent adapters share one instance so concurrent settings
 * updates cannot overwrite one another's read-modify-write changes. Consumers
 * receive the entire config object and must only mutate their owned top-level
 * property.
 */
export class OpenCodeConfigStore {
  private readonly userConfigDirectory?: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: OpenCodeConfigStoreOptions = {}) {
    this.userConfigDirectory = options.userConfigDirectory;
  }

  /** Used by the OpenCode MCP and agent adapters to read their shared config. */
  async readConfig(scope: McpScope, workspacePath = ''): Promise<Record<string, unknown>> {
    const { filePath } = await this.resolveConfigPath(scope, workspacePath);
    return this.readFile(filePath);
  }

  /**
   * Used by the OpenCode MCP and agent adapters for serialized config updates.
   * The updater may mutate the supplied object and can return a domain result.
   */
  async updateConfig<TResult>(
    scope: McpScope,
    workspacePath: string,
    updater: (config: Record<string, unknown>) => TResult | Promise<TResult>,
  ): Promise<TResult> {
    const operation = this.writeQueue.then(async () => {
      const { filePath } = await this.resolveConfigPath(scope, workspacePath);
      const config = await this.readFile(filePath);
      const result = await updater(config);
      await this.writeFile(filePath, config);
      return result;
    });

    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async resolveConfigPath(scope: McpScope, workspacePath: string): Promise<OpenCodeConfigPath> {
    const root = scope === 'user'
      ? this.userConfigDirectory ?? path.join(os.homedir(), '.config', 'opencode')
      : workspacePath;
    const jsonPath = path.join(root, 'opencode.json');
    const jsoncPath = path.join(root, 'opencode.jsonc');

    if (await fileExists(jsonPath)) {
      return { filePath: jsonPath, exists: true };
    }
    if (await fileExists(jsoncPath)) {
      return { filePath: jsoncPath, exists: true };
    }
    return { filePath: jsonPath, exists: false };
  }

  private async readFile(filePath: string): Promise<Record<string, unknown>> {
    try {
      const content = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(content))) as unknown;
      return readObjectRecord(parsed) ?? {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      throw error;
    }
  }

  private async writeFile(filePath: string, data: Record<string, unknown>): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, filePath);
  }
}
