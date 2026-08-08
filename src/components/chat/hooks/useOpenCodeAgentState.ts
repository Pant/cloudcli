import { useCallback, useEffect, useMemo, useState } from 'react';

import type { LLMProvider, ProviderAgentOption } from '../../../types/app';
import { authenticatedFetch } from '../../../utils/api';
import { DEFAULT_EFFORT_VALUE } from '../constants/providerEffort';
import { safeLocalStorage } from '../utils/chatStorage';

const STORAGE_KEY = 'opencode-selected-agent';
const MODEL_STORAGE_KEY = 'opencode-agent-models';
const PREFERENCES_STORAGE_KEY = 'opencode-agent-preferences';
const CATALOG_STORAGE_KEY = 'opencode-agent-catalogs';

type OpenCodeAvailableAgent = {
  name: string;
  description?: string;
  mode: 'primary' | 'subagent' | 'all';
  model?: string;
  reasoningEffort?: string;
};

export type OpenCodeAgentPreference = {
  model?: string;
  reasoningEffort: string;
};

export type OpenCodeAgentPreferenceCache = Record<string, OpenCodeAgentPreference>;

type AgentPreferencesEnvelope = {
  data?: {
    provider: LLMProvider;
    name: string;
    model?: string;
    reasoningEffort?: string;
  };
};

type AgentListEnvelope = {
  data?: {
    agents?: OpenCodeAvailableAgent[];
  };
};

type SessionAgentOverride = {
  sessionId: string;
  agent: string;
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

export const normalizeAgentPreference = (preference: {
  model?: string;
  reasoningEffort?: string;
}): OpenCodeAgentPreference => ({
  ...(preference.model?.trim() ? { model: preference.model.trim() } : {}),
  reasoningEffort: preference.reasoningEffort?.trim() || DEFAULT_EFFORT_VALUE,
});

export const agentPreferenceKey = (workspacePath: string | undefined, agent: string) => (
  `${workspacePath || 'global'}::${agent.trim()}`
);

export const hydrateAgentPreferences = (
  current: OpenCodeAgentPreferenceCache,
  workspacePath: string | undefined,
  agents: Array<{ name: string; model?: string; reasoningEffort?: string }>,
): OpenCodeAgentPreferenceCache => Object.fromEntries([
  ...Object.entries(current),
  ...agents.map((agent) => [
    agentPreferenceKey(workspacePath, agent.name),
    normalizeAgentPreference(agent),
  ]),
]);

export const resolveAgentPreference = (
  cache: OpenCodeAgentPreferenceCache,
  workspacePath: string | undefined,
  agent: string,
  runtimeOption?: Pick<ProviderAgentOption, 'model' | 'reasoningEffort'>,
): OpenCodeAgentPreference => cache[agentPreferenceKey(workspacePath, agent)]
  || normalizeAgentPreference(runtimeOption ?? {});

const readStoredAgentPreferences = (): OpenCodeAgentPreferenceCache => {
  try {
    const parsed = JSON.parse(safeLocalStorage.getItem(PREFERENCES_STORAGE_KEY) || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([key, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const candidate = value as { model?: unknown; reasoningEffort?: unknown };
      if (candidate.model !== undefined && typeof candidate.model !== 'string') return [];
      if (candidate.reasoningEffort !== undefined && typeof candidate.reasoningEffort !== 'string') return [];
      return [[key, normalizeAgentPreference(candidate as { model?: string; reasoningEffort?: string })]];
    }));
  } catch {
    return {};
  }
};

const readStoredAgentCatalogs = (): Record<string, ProviderAgentOption[]> => {
  try {
    const parsed = JSON.parse(safeLocalStorage.getItem(CATALOG_STORAGE_KEY) || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, ProviderAgentOption[]] => (
        Array.isArray(entry[1])
        && entry[1].every((option) => (
          option
          && typeof option === 'object'
          && typeof (option as ProviderAgentOption).value === 'string'
          && typeof (option as ProviderAgentOption).label === 'string'
        ))
      )),
    );
  } catch {
    return {};
  }
};

/** Owns the composer-level OpenCode agent choice and its workspace agent catalog. */
export function useOpenCodeAgentState(
  provider: LLMProvider,
  workspacePath?: string,
  sessionId?: string,
  sessionAgent?: string | null,
  sessionModel?: string | null,
) {
  const [selectedAgent, setSelectedAgent] = useState(readStoredAgent);
  const [sessionAgentOverride, setSessionAgentOverride] = useState<SessionAgentOverride | null>(null);
  const [agentCatalogs, setAgentCatalogs] = useState<Record<string, ProviderAgentOption[]>>(readStoredAgentCatalogs);
  const [loadedCatalogKeys, setLoadedCatalogKeys] = useState<Set<string>>(
    () => new Set(Object.keys(readStoredAgentCatalogs())),
  );
  const [loadingCatalogKey, setLoadingCatalogKey] = useState<string | null>(null);
  const [agentModels, setAgentModels] = useState<Record<string, string>>(readStoredAgentModels);
  const [agentPreferences, setAgentPreferences] = useState<OpenCodeAgentPreferenceCache>(readStoredAgentPreferences);
  const catalogKey = workspacePath || 'global';
  const agentOptions = useMemo(
    () => agentCatalogs[catalogKey] ?? [],
    [agentCatalogs, catalogKey],
  );
  const resolvedSelectedAgent = useMemo(() => {
    const normalizedSessionAgent = sessionAgent?.trim() || '';
    const normalizedSessionModel = sessionModel?.trim() || '';
    const overriddenSessionAgent = sessionId && sessionAgentOverride?.sessionId === sessionId
      ? sessionAgentOverride.agent
      : '';
    const modelAgentMatches = normalizedSessionModel
      ? agentOptions.filter((option) => (
          Boolean(option.model)
          && (
            option.model === normalizedSessionModel
            || normalizedSessionModel.endsWith(`/${option.model}`)
            || option.model?.endsWith(`/${normalizedSessionModel}`)
          )
        ))
      : [];
    const inferredSessionAgent = modelAgentMatches.length === 1
      ? modelAgentMatches[0].value
      : '';
    const authoritativeSessionAgent = overriddenSessionAgent
      || normalizedSessionAgent
      || inferredSessionAgent;

    // A loaded session owns its agent selection. Keep the stored value visible
    // even if that agent was later removed from the catalog; silently falling
    // back here is what caused child sessions to display their parent's agent.
    if (sessionId && authoritativeSessionAgent) {
      return authoritativeSessionAgent;
    }

    if (agentOptions.some((option) => option.value === selectedAgent)) {
      return selectedAgent;
    }
    return agentOptions.find((option) => option.mode !== 'subagent')?.value
      || agentOptions[0]?.value
      || selectedAgent;
  }, [agentOptions, selectedAgent, sessionAgent, sessionAgentOverride, sessionId, sessionModel]);
  const agentsLoading = provider === 'opencode'
    && (loadingCatalogKey === catalogKey || !loadedCatalogKeys.has(catalogKey));
  const agentModelKey = useCallback(
    (agent: string) => `${workspacePath || 'global'}::${agent}`,
    [workspacePath],
  );

  const loadAgents = useCallback(async () => {
    if (provider !== 'opencode') {
      return;
    }

    const requestCatalogKey = workspacePath || 'global';
    setLoadingCatalogKey(requestCatalogKey);
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
          reasoningEffort: agent.reasoningEffort,
        }));

      setAgentPreferences((current) => {
        const nextPreferences = hydrateAgentPreferences(current, workspacePath, payload.data?.agents ?? []);
        safeLocalStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(nextPreferences));
        return nextPreferences;
      });

      setAgentCatalogs((current) => {
        const nextCatalogs = { ...current, [requestCatalogKey]: nextOptions };
        safeLocalStorage.setItem(CATALOG_STORAGE_KEY, JSON.stringify(nextCatalogs));
        return nextCatalogs;
      });
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
      setLoadedCatalogKeys((current) => new Set(current).add(requestCatalogKey));
      setLoadingCatalogKey((current) => current === requestCatalogKey ? null : current);
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
    if (sessionId) {
      setSessionAgentOverride({ sessionId, agent: normalizedAgent });
    }
    safeLocalStorage.setItem(STORAGE_KEY, normalizedAgent);
  }, [sessionId]);

  const rememberAgentModel = useCallback((agent: string, model: string) => {
    if (!agent.trim() || !model.trim()) {
      return;
    }
    setAgentModels((current) => {
      const nextModels = { ...current, [agentModelKey(agent)]: model };
      safeLocalStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(nextModels));
      return nextModels;
    });
    setAgentPreferences((current) => {
      const key = agentModelKey(agent);
      const next = { ...current, [key]: { ...normalizeAgentPreference(current[key] ?? {}), model: model.trim() } };
      safeLocalStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, [agentModelKey]);

  const getAgentModel = useCallback((agent: string) => (
    agentPreferences[agentModelKey(agent)]?.model
    || agentModels[agentModelKey(agent)]
    || agentOptions.find((option) => option.value === agent)?.model
  ), [agentModelKey, agentModels, agentOptions, agentPreferences]);

  const getAgentPreferences = useCallback((agent: string) => resolveAgentPreference(
    agentPreferences,
    workspacePath,
    agent,
    agentOptions.find((option) => option.value === agent),
  ), [agentOptions, agentPreferences, workspacePath]);

  const updateAgentPreferences = useCallback(async (
    agent: string,
    patch: { model?: string; reasoningEffort?: string },
  ): Promise<OpenCodeAgentPreference> => {
    const normalizedAgent = agent.trim();
    const normalizedPatch = {
      ...(patch.model?.trim() ? { model: patch.model.trim() } : {}),
      ...(patch.reasoningEffort?.trim() ? { reasoningEffort: patch.reasoningEffort.trim() } : {}),
    };
    const response = await authenticatedFetch(
      `/api/providers/opencode/agents/${encodeURIComponent(normalizedAgent)}/preferences`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(normalizedPatch) },
    );
    if (!response.ok) throw new Error(`Failed to update OpenCode agent preferences (${response.status})`);
    const payload = await response.json() as AgentPreferencesEnvelope;
    if (!payload.data || payload.data.name !== normalizedAgent || payload.data.provider !== 'opencode') {
      throw new Error('Invalid OpenCode agent preferences response');
    }
    const normalized = normalizeAgentPreference(payload.data);
    setAgentPreferences((current) => {
      const next = { ...current, [agentModelKey(normalizedAgent)]: normalized };
      safeLocalStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
    if (normalized.model) {
      setAgentModels((current) => {
        const next = { ...current, [agentModelKey(normalizedAgent)]: normalized.model as string };
        safeLocalStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(next));
        return next;
      });
    }
    return normalized;
  }, [agentModelKey]);

  return {
    selectedAgent: resolvedSelectedAgent,
    agentOptions: provider === 'opencode' ? agentOptions : [],
    agentsLoading,
    selectAgent,
    rememberAgentModel,
    getAgentModel,
    getAgentPreferences,
    updateAgentPreferences,
    refreshAgents: loadAgents,
  };
}
