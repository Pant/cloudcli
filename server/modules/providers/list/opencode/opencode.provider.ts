import { OpenCodeProviderAuth } from '@/modules/providers/list/opencode/opencode-auth.provider.js';
import { OpenCodeAgentsProvider } from '@/modules/providers/list/opencode/opencode-agents.provider.js';
import { OpenCodeConfigStore } from '@/modules/providers/list/opencode/opencode-config.provider.js';
import { OpenCodeProviderModels } from '@/modules/providers/list/opencode/opencode-models.provider.js';
import { opencodeRuntime } from '@/modules/providers/list/opencode/opencode-runtime.provider.js';
import { OpenCodeMcpProvider } from '@/modules/providers/list/opencode/opencode-mcp.provider.js';
import { OpenCodeSessionSynchronizer } from '@/modules/providers/list/opencode/opencode-session-synchronizer.provider.js';
import { OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import { OpenCodeSkillsProvider } from '@/modules/providers/list/opencode/opencode-skills.provider.js';
import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import type {
  IProviderAuth,
  IProviderAgents,
  IProviderModels,
  IProviderRuntime,
  IProviderSessionSynchronizer,
  IProviderSkills,
  IProviderSessions,
} from '@/shared/interfaces.js';

export class OpenCodeProvider extends AbstractProvider {
  readonly runtime: IProviderRuntime = opencodeRuntime;
  readonly models: IProviderModels = new OpenCodeProviderModels();
  readonly mcp: OpenCodeMcpProvider;
  readonly agents: IProviderAgents;
  readonly auth: IProviderAuth = new OpenCodeProviderAuth();
  readonly skills: IProviderSkills = new OpenCodeSkillsProvider();
  readonly sessions: IProviderSessions = new OpenCodeSessionsProvider(this.models);
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new OpenCodeSessionSynchronizer();

  constructor() {
    super('opencode');
    const configStore = new OpenCodeConfigStore();
    this.mcp = new OpenCodeMcpProvider(configStore);
    this.agents = new OpenCodeAgentsProvider(configStore);
  }
}
