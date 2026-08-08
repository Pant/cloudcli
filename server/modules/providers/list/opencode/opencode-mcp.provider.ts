import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
} from '@/shared/utils.js';

import { OpenCodeConfigStore } from './opencode-config.provider.js';

export class OpenCodeMcpProvider extends McpProvider {
  constructor(private readonly configStore = new OpenCodeConfigStore()) {
    super('opencode', ['user', 'project'], ['stdio', 'http']);
  }

  protected async readScopedServers(scope: McpScope, workspacePath: string): Promise<Record<string, unknown>> {
    const config = await this.configStore.readConfig(scope, workspacePath);
    return readObjectRecord(config.mcp) ?? {};
  }

  protected async writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
  ): Promise<void> {
    await this.configStore.updateConfig(scope, workspacePath, (config) => {
      config.mcp = servers;
    });
  }

  protected buildServerConfig(
    input: UpsertProviderMcpServerInput,
    existingConfig?: unknown,
  ): Record<string, unknown> {
    const existing = readObjectRecord(existingConfig);
    const enabled = input.enabled ?? (typeof existing?.enabled === 'boolean' ? existing.enabled : true);

    if (input.transport === 'stdio') {
      if (!input.command?.trim()) {
        throw new AppError('command is required for stdio MCP servers.', {
          code: 'MCP_COMMAND_REQUIRED',
          statusCode: 400,
        });
      }

      return {
        type: 'local',
        command: [input.command, ...(input.args ?? [])],
        enabled,
        environment: input.env ?? {},
      };
    }

    if (!input.url?.trim()) {
      throw new AppError('url is required for http MCP servers.', {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }

    return {
      type: 'remote',
      url: input.url,
      enabled,
      headers: input.headers ?? {},
    };
  }

  protected normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null {
    const config = readObjectRecord(rawConfig);
    if (!config) {
      return null;
    }

    if (config.type === 'local' || config.command !== undefined) {
      const commandParts = typeof config.command === 'string'
        ? [config.command, ...(readStringArray(config.args) ?? [])]
        : readStringArray(config.command);
      const command = commandParts?.[0];
      if (!command) {
        return null;
      }

      return {
        provider: 'opencode',
        name,
        scope,
        transport: 'stdio',
        enabled: typeof config.enabled === 'boolean' ? config.enabled : true,
        command,
        args: commandParts.slice(1),
        env: readStringRecord(config.environment) ?? readStringRecord(config.env),
      };
    }

    if (config.type === 'remote' || typeof config.url === 'string') {
      const url = readOptionalString(config.url);
      if (!url) {
        return null;
      }

      return {
        provider: 'opencode',
        name,
        scope,
        transport: 'http',
        enabled: typeof config.enabled === 'boolean' ? config.enabled : true,
        url,
        headers: readStringRecord(config.headers),
      };
    }

    return null;
  }
}
