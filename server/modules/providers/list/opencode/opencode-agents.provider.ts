import spawn from 'cross-spawn';

import type { IProviderAgents } from '@/shared/interfaces.js';
import type {
  ProviderAvailableAgent,
  ProviderAgentListOptions,
  ProviderAgentDefinition,
  ProviderAgentPermissionAction,
  ProviderAgentPermissionValue,
  ProviderAgentPreferencesPatch,
  ProviderAgentPreferencesResult,
  UpsertProviderAgentInput,
} from '@/shared/types.js';
import { AppError, readObjectRecord } from '@/shared/utils.js';

import { OpenCodeConfigStore } from './opencode-config.provider.js';

const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const MODEL_REFERENCE_PATTERN = /^[^\s/]+\/[^\s]+$/;
const BARE_MODEL_ID_PATTERN = /^[^\s/]+$/;
const PERMISSION_ACTIONS = new Set<ProviderAgentPermissionAction>(['allow', 'ask', 'deny']);
const THEME_COLORS = new Set(['primary', 'secondary', 'accent', 'success', 'warning', 'error', 'info']);
const AVAILABLE_AGENT_CACHE_TTL_MS = 15_000;
const AGENT_DETAILS_CONCURRENCY = 4;
const RESERVED_AGENT_OPTIONS = new Set([
  'description',
  'mode',
  'model',
  'prompt',
  'temperature',
  'top_p',
  'steps',
  'disable',
  'hidden',
  'color',
  'permission',
  'tools',
]);

type OpenCodeAgentListRunner = (workspacePath?: string) => Promise<string>;
type OpenCodeAgentDetailsRunner = (name: string, workspacePath?: string) => Promise<string>;

const runOpenCodeCommand = (args: string[], workspacePath?: string): Promise<string> => new Promise((resolve, reject) => {
  const child = spawn('opencode', args, {
    cwd: workspacePath || undefined,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';

  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.on('error', (error) => {
    reject(new AppError(`Unable to inspect OpenCode agents: ${error.message}`, {
      code: 'OPENCODE_AGENT_LIST_FAILED',
      statusCode: 502,
    }));
  });
  child.on('close', (code) => {
    if (code === 0) {
      resolve(stdout);
      return;
    }
    reject(new AppError(
      `OpenCode agent inspection failed${stderr.trim() ? `: ${stderr.trim()}` : ` with exit code ${code}`}`,
      { code: 'OPENCODE_AGENT_LIST_FAILED', statusCode: 502 },
    ));
  });
});

const runOpenCodeAgentList: OpenCodeAgentListRunner = (workspacePath) => (
  runOpenCodeCommand(['agent', 'list'], workspacePath)
);

const runOpenCodeAgentDetails: OpenCodeAgentDetailsRunner = (name, workspacePath) => (
  runOpenCodeCommand(['debug', 'agent', name], workspacePath)
);

const parseAvailableAgents = (output: string): ProviderAvailableAgent[] => {
  const agentsByName = new Map<string, ProviderAvailableAgent>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,119}) \((primary|subagent|all)\)\s*$/.exec(line.trim());
    if (!match) {
      continue;
    }
    agentsByName.set(match[1], {
      name: match[1],
      mode: match[2] as ProviderAvailableAgent['mode'],
    });
  }
  return [...agentsByName.values()];
};

type OpenCodeRuntimeAgentDetails = {
  description?: string;
  model?: string;
  mode?: ProviderAvailableAgent['mode'];
  native: boolean;
  hidden: boolean;
  disable: boolean;
  reasoningEffort?: string;
};

const parseRuntimeAgentDetails = (name: string, output: string): OpenCodeRuntimeAgentDetails => {
  try {
    const details = readObjectRecord(JSON.parse(output));
    if (!details) {
      throw new Error('response was not an object');
    }
    const mode = details.mode === 'primary' || details.mode === 'subagent' || details.mode === 'all'
      ? details.mode
      : undefined;
    const modelRecord = readObjectRecord(details.model);
    const modelProvider = modelRecord && typeof modelRecord.providerID === 'string'
      ? modelRecord.providerID.trim()
      : '';
    const modelId = modelRecord && typeof modelRecord.modelID === 'string'
      ? modelRecord.modelID.trim()
      : '';
    const model = typeof details.model === 'string' && details.model.trim()
      ? details.model.trim()
      : modelProvider
        ? [modelProvider, modelId].filter(Boolean).join('/')
        : undefined;
    const options = readObjectRecord(details.options);
    const reasoningEffort = optionalString(options?.reasoningEffort ?? details.reasoningEffort);
    return {
      description: typeof details.description === 'string' && details.description.trim()
        ? details.description.trim()
        : undefined,
      mode,
      model,
      native: details.native === true,
      hidden: details.hidden === true,
      disable: details.disable === true,
      reasoningEffort,
    };
  } catch (error) {
    throw new AppError(
      `OpenCode returned invalid details for agent "${name}": ${error instanceof Error ? error.message : String(error)}`,
      { code: 'OPENCODE_AGENT_DETAILS_INVALID', statusCode: 502 },
    );
  }
};

const invalidAgent = (message: string, code = 'INVALID_OPENCODE_AGENT'): never => {
  throw new AppError(message, { code, statusCode: 400 });
};

const optionalString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
);

const optionalBoolean = (value: unknown): boolean | undefined => (
  typeof value === 'boolean' ? value : undefined
);

const optionalNumber = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

const readPermissionAction = (value: unknown): ProviderAgentPermissionAction | undefined => (
  typeof value === 'string' && PERMISSION_ACTIONS.has(value as ProviderAgentPermissionAction)
    ? value as ProviderAgentPermissionAction
    : undefined
);

const normalizePermission = (value: unknown): Record<string, ProviderAgentPermissionValue> | undefined => {
  const permission = readObjectRecord(value);
  if (!permission) {
    return undefined;
  }

  const entries = Object.entries(permission).flatMap<[string, ProviderAgentPermissionValue]>(([key, rawValue]) => {
    const action = readPermissionAction(rawValue);
    if (action) {
      return [[key, action]];
    }

    const rules = readObjectRecord(rawValue);
    if (!rules) {
      return [];
    }
    const normalizedRules = Object.fromEntries(
      Object.entries(rules).flatMap(([pattern, rawAction]) => {
        const ruleAction = readPermissionAction(rawAction);
        return ruleAction ? [[pattern, ruleAction]] : [];
      }),
    );
    return [[key, normalizedRules]];
  });

  return Object.fromEntries(entries);
};

const normalizeTools = (value: unknown): Record<string, boolean> | undefined => {
  const tools = readObjectRecord(value);
  if (!tools) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(tools).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
  );
};

const normalizeAgent = (name: string, value: unknown): ProviderAgentDefinition | null => {
  const config = readObjectRecord(value);
  if (!config) {
    return null;
  }

  const options = Object.fromEntries(
    Object.entries(config).filter(([key]) => !RESERVED_AGENT_OPTIONS.has(key)),
  );
  const rawMode = config.mode;
  const mode = rawMode === 'primary' || rawMode === 'subagent' || rawMode === 'all'
    ? rawMode
    : undefined;

  return {
    name,
    description: optionalString(config.description) ?? '',
    mode,
    model: optionalString(config.model),
    prompt: typeof config.prompt === 'string' ? config.prompt : undefined,
    temperature: optionalNumber(config.temperature),
    topP: optionalNumber(config.top_p),
    steps: optionalNumber(config.steps),
    disable: optionalBoolean(config.disable),
    hidden: optionalBoolean(config.hidden),
    color: optionalString(config.color),
    permission: normalizePermission(config.permission),
    tools: normalizeTools(config.tools),
    options,
  };
};

const requiredAgentName = (value: unknown, fieldName = 'name'): string => {
  const name = optionalString(value);
  if (!name || !AGENT_NAME_PATTERN.test(name)) {
    return invalidAgent(
      `${fieldName} must be 1-120 characters and contain only letters, numbers, dots, underscores, or hyphens.`,
      'INVALID_OPENCODE_AGENT_NAME',
    );
  }
  return name;
};

const requiredDescription = (value: unknown): string => {
  const description = optionalString(value);
  if (!description) {
    return invalidAgent('description is required.', 'OPENCODE_AGENT_DESCRIPTION_REQUIRED');
  }
  if (description.length > 2_000) {
    return invalidAgent('description must not exceed 2000 characters.');
  }
  return description;
};

const normalizeAgentModel = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    return invalidAgent('model must be a string.');
  }

  const model = value.trim();
  if (!model) {
    return undefined;
  }
  if (MODEL_REFERENCE_PATTERN.test(model)) {
    return model;
  }

  // CloudCLI's generated OpenAI-compatible provider owns bare model ids from
  // its /models response. Qualify them before OpenCode parses the first path
  // segment as a provider and leaves modelID empty (`model-id/`).
  const cloudCliProvider = optionalString(process.env.CLOUDCLI_OPENCODE_PROVIDER_ID);
  if (BARE_MODEL_ID_PATTERN.test(model) && cloudCliProvider && !cloudCliProvider.includes('/')) {
    return `${cloudCliProvider}/${model}`;
  }

  return invalidAgent('model must use provider/model-id format.');
};

const validateOptionalNumber = (
  value: unknown,
  fieldName: string,
  minimum: number,
  maximum: number,
  integer = false,
): number | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
    || (integer && !Number.isInteger(value))
  ) {
    return invalidAgent(
      `${fieldName} must be ${integer ? 'an integer' : 'a number'} between ${minimum} and ${maximum}.`,
    );
  }
  return value;
};

const validatePermission = (value: unknown): Record<string, ProviderAgentPermissionValue> | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const permission = readObjectRecord(value);
  if (!permission) {
    return invalidAgent('permission must be a JSON object.');
  }

  return Object.fromEntries(Object.entries(permission).map(([key, rawValue]) => {
    if (!key.trim()) {
      return invalidAgent('permission keys must not be empty.');
    }
    const action = readPermissionAction(rawValue);
    if (action) {
      return [key, action];
    }
    const rawRules = readObjectRecord(rawValue);
    if (!rawRules) {
      return invalidAgent(`permission.${key} must be allow, ask, deny, or a pattern object.`);
    }
    const rules = Object.fromEntries(Object.entries(rawRules).map(([pattern, rawAction]) => {
      const ruleAction = readPermissionAction(rawAction);
      if (!pattern || !ruleAction) {
        return invalidAgent(`permission.${key} pattern values must be allow, ask, or deny.`);
      }
      return [pattern, ruleAction];
    }));
    return [key, rules];
  }));
};

const validateTools = (value: unknown): Record<string, boolean> | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const tools = readObjectRecord(value);
  if (!tools || Object.values(tools).some((enabled) => typeof enabled !== 'boolean')) {
    return invalidAgent('tools must be a JSON object containing only boolean values.');
  }
  return Object.fromEntries(Object.entries(tools)) as Record<string, boolean>;
};

const validateOptions = (value: unknown): Record<string, unknown> => {
  if (value === undefined || value === null) {
    return {};
  }
  const options = readObjectRecord(value);
  if (!options) {
    return invalidAgent('options must be a JSON object.');
  }
  const reservedKey = Object.keys(options).find((key) => RESERVED_AGENT_OPTIONS.has(key));
  if (reservedKey) {
    return invalidAgent(`options.${reservedKey} must be set through its dedicated field.`);
  }
  return Object.fromEntries(Object.entries(options));
};

const validateAgent = (input: UpsertProviderAgentInput): UpsertProviderAgentInput => {
  const name = requiredAgentName(input.name);
  const originalName = input.originalName === undefined
    ? undefined
    : requiredAgentName(input.originalName, 'originalName');
  const mode = input.mode ?? 'all';
  if (mode !== 'primary' && mode !== 'subagent' && mode !== 'all') {
    return invalidAgent('mode must be primary, subagent, or all.');
  }
  if (input.prompt !== undefined && typeof input.prompt !== 'string') {
    return invalidAgent('prompt must be a string.');
  }
  if (input.prompt && input.prompt.length > 500_000) {
    return invalidAgent('prompt must not exceed 500000 characters.');
  }
  if (input.disable !== undefined && typeof input.disable !== 'boolean') {
    return invalidAgent('disable must be a boolean.');
  }
  if (input.hidden !== undefined && typeof input.hidden !== 'boolean') {
    return invalidAgent('hidden must be a boolean.');
  }
  if (input.color !== undefined) {
    if (typeof input.color !== 'string') {
      return invalidAgent('color must be a string.');
    }
    const normalizedColor = input.color.trim().toLowerCase();
    if (normalizedColor && !THEME_COLORS.has(normalizedColor) && !/^#[0-9a-f]{6}$/i.test(normalizedColor)) {
      return invalidAgent('color must be a six-digit hex color or an OpenCode theme color.');
    }
  }

  return {
    name,
    originalName,
    description: requiredDescription(input.description),
    mode,
    model: normalizeAgentModel(input.model),
    prompt: input.prompt || undefined,
    temperature: validateOptionalNumber(input.temperature, 'temperature', 0, 1),
    topP: validateOptionalNumber(input.topP, 'topP', 0, 1),
    steps: validateOptionalNumber(input.steps, 'steps', 1, 100_000, true),
    disable: input.disable,
    hidden: input.hidden,
    color: optionalString(input.color),
    permission: validatePermission(input.permission),
    tools: validateTools(input.tools),
    options: validateOptions(input.options),
  };
};

const toOpenCodeConfig = (agent: UpsertProviderAgentInput): Record<string, unknown> => {
  const config: Record<string, unknown> = {
    ...agent.options,
    description: agent.description,
    mode: agent.mode,
  };
  if (agent.model) config.model = agent.model;
  if (agent.prompt) config.prompt = agent.prompt;
  if (agent.temperature !== undefined) config.temperature = agent.temperature;
  if (agent.topP !== undefined) config.top_p = agent.topP;
  if (agent.steps !== undefined) config.steps = agent.steps;
  if (agent.disable !== undefined) config.disable = agent.disable;
  if (agent.hidden !== undefined) config.hidden = agent.hidden;
  if (agent.color) config.color = agent.color;
  if (agent.permission) config.permission = agent.permission;
  if (agent.tools) config.tools = agent.tools;
  return config;
};

/**
 * OpenCode implementation of global named-agent configuration.
 *
 * This adapter exclusively reads and writes the user config's `agent` object;
 * it never accepts a workspace path and therefore cannot create project agents.
 */
export class OpenCodeAgentsProvider implements IProviderAgents {
  private readonly availableAgentCache = new Map<string, { expiresAt: number; agents: ProviderAvailableAgent[] }>();
  private readonly availableAgentInFlight = new Map<string, Promise<ProviderAvailableAgent[]>>();

  constructor(
    private readonly configStore = new OpenCodeConfigStore(),
    private readonly agentListRunner: OpenCodeAgentListRunner = runOpenCodeAgentList,
    private readonly agentDetailsRunner: OpenCodeAgentDetailsRunner = runOpenCodeAgentDetails,
  ) {}

  async listAvailableAgents(options: ProviderAgentListOptions = {}): Promise<ProviderAvailableAgent[]> {
    const cacheKey = options.workspacePath || '';
    const inFlight = this.availableAgentInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }
    const cached = this.availableAgentCache.get(cacheKey);
    if (!options.refresh && cached && cached.expiresAt > Date.now()) {
      return cached.agents;
    }

    const discovery = this.discoverAvailableAgents(options.workspacePath);
    this.availableAgentInFlight.set(cacheKey, discovery);
    try {
      const agents = await discovery;
      this.availableAgentCache.set(cacheKey, {
        expiresAt: Date.now() + AVAILABLE_AGENT_CACHE_TTL_MS,
        agents,
      });
      return agents;
    } finally {
      if (this.availableAgentInFlight.get(cacheKey) === discovery) {
        this.availableAgentInFlight.delete(cacheKey);
      }
    }
  }

  private async discoverAvailableAgents(workspacePath?: string): Promise<ProviderAvailableAgent[]> {
    const discoveredAgents = parseAvailableAgents(await this.agentListRunner(workspacePath));
    const inspectedAgents: Array<{
      agent: ProviderAvailableAgent;
      details: OpenCodeRuntimeAgentDetails;
      originalIndex: number;
    }> = new Array(discoveredAgents.length);
    let nextIndex = 0;
    const inspectNext = async (): Promise<void> => {
      while (nextIndex < discoveredAgents.length) {
        const originalIndex = nextIndex++;
        const agent = discoveredAgents[originalIndex];
        const details = parseRuntimeAgentDetails(
          agent.name,
          await this.agentDetailsRunner(agent.name, workspacePath),
        );
        inspectedAgents[originalIndex] = { agent, details, originalIndex };
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(AGENT_DETAILS_CONCURRENCY, discoveredAgents.length) },
      () => inspectNext(),
    ));

    // The CLI's native flag is the authoritative custom/built-in distinction.
    // Preserve discovery order inside each group while moving custom agents up.
    return inspectedAgents
      .filter(({ details }) => !details.disable && !details.hidden)
      .sort((left, right) => (
        Number(left.details.native) - Number(right.details.native)
        || left.originalIndex - right.originalIndex
      ))
      .map(({ agent, details }) => ({
        ...agent,
        mode: details.mode ?? agent.mode,
        description: details.description,
        model: details.model,
        reasoningEffort: details.reasoningEffort,
      }));
  }

  private invalidateAvailableAgents(): void {
    this.availableAgentCache.clear();
  }

  async listAgents(): Promise<ProviderAgentDefinition[]> {
    const config = await this.configStore.readConfig('user');
    const agents = readObjectRecord(config.agent) ?? {};
    return Object.entries(agents)
      .flatMap(([name, value]) => {
        const agent = normalizeAgent(name, value);
        return agent ? [agent] : [];
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async upsertAgent(input: UpsertProviderAgentInput): Promise<ProviderAgentDefinition> {
    const agent = validateAgent(input);
    const saved = await this.configStore.updateConfig('user', '', (config) => {
      const agents = { ...(readObjectRecord(config.agent) ?? {}) };
      const previousName = agent.originalName ?? agent.name;
      if (previousName !== agent.name && agents[agent.name] !== undefined) {
        return invalidAgent(`An OpenCode agent named "${agent.name}" already exists.`, 'OPENCODE_AGENT_EXISTS');
      }
      if (previousName !== agent.name) {
        delete agents[previousName];
      }
      agents[agent.name] = toOpenCodeConfig(agent);
      config.agent = agents;
      return normalizeAgent(agent.name, agents[agent.name]) as ProviderAgentDefinition;
    });
    this.invalidateAvailableAgents();
    return saved;
  }

  async updateAgentPreferences(
    nameInput: string,
    patch: ProviderAgentPreferencesPatch,
  ): Promise<ProviderAgentPreferencesResult> {
    const name = requiredAgentName(nameInput);
    const hasModel = Object.prototype.hasOwnProperty.call(patch, 'model');
    const hasReasoning = Object.prototype.hasOwnProperty.call(patch, 'reasoningEffort');
    if (!hasModel && !hasReasoning) {
      return invalidAgent('At least one of model or reasoningEffort is required.', 'OPENCODE_AGENT_PREFERENCES_REQUIRED');
    }

    const model = hasModel ? normalizeAgentModel(patch.model) : undefined;
    if (hasModel && !model) {
      return invalidAgent('model must be a non-empty string.', 'INVALID_OPENCODE_AGENT_MODEL');
    }
    if (hasReasoning && typeof patch.reasoningEffort !== 'string') {
      return invalidAgent('reasoningEffort must be a string.', 'INVALID_OPENCODE_REASONING_EFFORT');
    }
    const reasoningEffort = hasReasoning ? patch.reasoningEffort!.trim() : undefined;
    if (hasReasoning && !reasoningEffort) {
      return invalidAgent('reasoningEffort must be a non-empty string.', 'INVALID_OPENCODE_REASONING_EFFORT');
    }

    const preferences = await this.configStore.updateConfig('user', '', (config) => {
      const agents = readObjectRecord(config.agent);
      const existing = agents && readObjectRecord(agents[name]);
      if (!agents || !existing) {
        throw new AppError(`OpenCode global agent "${name}" was not found or is not configurable.`, {
          code: 'OPENCODE_AGENT_NOT_CONFIGURABLE',
          statusCode: 404,
        });
      }

      const updated = { ...existing };
      if (hasModel) updated.model = model;
      if (hasReasoning) {
        if (reasoningEffort === 'default') delete updated.reasoningEffort;
        else updated.reasoningEffort = reasoningEffort;
      }
      config.agent = { ...agents, [name]: updated };
      return {
        provider: 'opencode' as const,
        name,
        model: optionalString(updated.model),
        reasoningEffort: optionalString(updated.reasoningEffort),
      };
    });
    this.invalidateAvailableAgents();
    return preferences;
  }

  async removeAgent(nameInput: string): Promise<{ removed: boolean; provider: 'opencode'; name: string }> {
    const name = requiredAgentName(nameInput);
    const result = await this.configStore.updateConfig('user', '', (config) => {
      const agents = { ...(readObjectRecord(config.agent) ?? {}) };
      const removed = Object.prototype.hasOwnProperty.call(agents, name);
      if (removed) {
        delete agents[name];
        config.agent = agents;
      }
      return { removed, provider: 'opencode' as const, name };
    });
    if (result.removed) this.invalidateAvailableAgents();
    return result;
  }
}
