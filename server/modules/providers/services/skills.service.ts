import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type {
  ProviderSkill,
  ProviderSkillCreateInput,
  ProviderSkillListOptions,
  ProviderSkillRemoveInput,
  ProviderSkillAccessUpdateInput,
  ProviderSkillAccessUpdateResult,
} from '@/shared/types.js';

export const providerSkillsService = {
  /**
   * Lists normalized skills visible to one provider.
   */
  async listProviderSkills(
    providerName: string,
    options?: ProviderSkillListOptions,
  ): Promise<ProviderSkill[]> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.skills.listSkills(options);
  },

  /**
   * Writes one or more global skills for one provider.
   */
  async addProviderSkills(
    providerName: string,
    input: ProviderSkillCreateInput,
  ): Promise<ProviderSkill[]> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.skills.addSkills(input);
  },

  async removeProviderSkill(
    providerName: string,
    input: ProviderSkillRemoveInput,
  ): Promise<{ removed: boolean; provider: string; directoryName: string }> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.skills.removeSkill(input);
  },

  /** Updates one provider skill's effective access at the requested scope. */
  async updateProviderSkillAccess(
    providerName: string,
    input: ProviderSkillAccessUpdateInput,
  ): Promise<ProviderSkillAccessUpdateResult> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.skills.updateSkillAccess(input);
  },
};
