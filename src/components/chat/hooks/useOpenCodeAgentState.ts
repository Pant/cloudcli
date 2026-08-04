import { useCallback, useEffect, useState } from 'react';

import type { LLMProvider, ProviderAgentOption } from '../../../types/app';
import { authenticatedFetch } from '../../../utils/api';
import { safeLocalStorage } from '../utils/chatStorage';

const STORAGE_KEY = 'opencode-selected-agent';
const MODEL_STORAGE_KEY = 'opencode-agent-models';

type OpenCodeAvailableAgent = {
  name: string;
  description?: string;
  mode: 'primary' | 'subagent' | 'all';
  model?: string;
};

type AgentListEnvelope = {
  data?: {
    agents?: OpenCodeAvailableAgent[];
  };
};

const readStoredAgent = () => safeLocalStorage.getItem(STORAGE_KEY)?.trim() || '';

const readStoredAgentModels = (): Record<string, string> => {
  try {
    const parsed = JSON.parse(safeLocalStorage.getItem(MODEL_STORAGE_KEY) || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch {
    return {};
  }
};

/** Owns the composer-level OpenCode agent choice and its global agent catalog. */
export function useOpenCodeAgentState(provider: LLMProvider, workspacePath?: string) {
  const [selectedAgent, setSelectedAgent] = useState(readStoredAgent);
  const [agentOptions, setAgentOptions] = useState<ProviderAgentOption[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentModels, setAgentModels] = useState<Record<string, string>>(readStoredAgentModels);
  const agentModelKey = useCallback(
    (agent: string) => `${workspacePath || 'global'}::${agent}`,
    [workspacePath],
  );

  const loadAgents = useCallback(async () => {
    if (provider !== 'opencode') {
      return;
    }

    setAgentsLoading(true);
    try {
      const query = new URLSearchParams();
      if (workspacePath) {
        query.set('workspacePath', workspacePath);
      }
      const response = await authenticatedFetch(
        `/api/providers/opencode/agents/available${query.size > 0 ? `?${query}` : ''}`,
      );
      if (!response.ok) {
        throw new Error(`Failed to load OpenCode agents (${response.status})`);
      }

      const payload = await response.json() as AgentListEnvelope;
      const nextOptions = (payload.data?.agents ?? [])
        .map<ProviderAgentOption>((agent) => ({
          value: agent.name,
          label: agent.name,
          description: agent.description || (agent.mode === 'subagent' ? 'Subagent' : 'Primary agent'),
          mode: agent.mode,
          model: agent.model,
        }));

      setAgentOptions(nextOptions);
      setSelectedAgent((current) => {
        if (nextOptions.some((agent) => agent.value === current)) {
          return current;
        }
        const nextAgent = nextOptions.find((agent) => agent.mode !== 'subagent')?.value
          || nextOptions[0]?.value
          || '';
        if (nextAgent) {
          safeLocalStorage.setItem(STORAGE_KEY, nextAgent);
        } else {
          safeLocalStorage.removeItem(STORAGE_KEY);
        }
        return nextAgent;
      });
    } catch (error) {
      console.error('Error loading OpenCode agents:', error);
    } finally {
      setAgentsLoading(false);
    }
  }, [provider, workspacePath]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  const selectAgent = useCallback((agent: string) => {
    const normalizedAgent = agent.trim();
    if (!normalizedAgent) {
      return;
    }
    setSelectedAgent(normalizedAgent);
    safeLocalStorage.setItem(STORAGE_KEY, normalizedAgent);
  }, []);

  const rememberAgentModel = useCallback((agent: string, model: string) => {
    if (!agent.trim() || !model.trim()) {
      return;
    }
    setAgentModels((current) => {
      const nextModels = { ...current, [agentModelKey(agent)]: model };
      safeLocalStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(nextModels));
      return nextModels;
    });
  }, [agentModelKey]);

  const getAgentModel = useCallback((agent: string) => (
    agentModels[agentModelKey(agent)]
    || agentOptions.find((option) => option.value === agent)?.model
  ), [agentModelKey, agentModels, agentOptions]);

  return {
    selectedAgent,
    agentOptions: provider === 'opencode' ? agentOptions : [],
    agentsLoading,
    selectAgent,
    rememberAgentModel,
    getAgentModel,
    refreshAgents: loadAgents,
  };
}
