import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type {
  ProviderAgentDefinition,
  ProviderAgentPreferencesPatch,
  ProviderAgentPreferencesResult,
  UpsertProviderAgentInput,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const resolveAgentProvider = (providerName: string) => {
  const provider = providerRegistry.resolveProvider(providerName);
  if (!provider.agents) {
    throw new AppError(`Provider "${providerName}" does not support configurable agents.`, {
      code: 'PROVIDER_AGENTS_UNSUPPORTED',
      statusCode: 400,
    });
  }
  return provider;
};

/** Provider routes use this service to manage user-global agent definitions. */
export const providerAgentsService = {
  async listAvailableProviderAgents(providerName: string, workspacePath?: string, refresh = false) {
    return resolveAgentProvider(providerName).agents!.listAvailableAgents({ workspacePath, refresh });
  },

  async listProviderAgents(providerName: string): Promise<ProviderAgentDefinition[]> {
    return resolveAgentProvider(providerName).agents!.listAgents();
  },

  async upsertProviderAgent(
    providerName: string,
    input: UpsertProviderAgentInput,
  ): Promise<ProviderAgentDefinition> {
    return resolveAgentProvider(providerName).agents!.upsertAgent(input);
  },

  async removeProviderAgent(providerName: string, name: string) {
    return resolveAgentProvider(providerName).agents!.removeAgent(name);
  },

  async updateProviderAgentPreferences(
    providerName: string,
    name: string,
    patch: ProviderAgentPreferencesPatch,
  ): Promise<ProviderAgentPreferencesResult> {
    return resolveAgentProvider(providerName).agents!.updateAgentPreferences(name, patch);
  },
};
