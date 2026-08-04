import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  Bot,
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react';

import { authenticatedFetch } from '../../../../../../../utils/api';
import SettingsCard from '../../../../SettingsCard';
import SettingsRow from '../../../../SettingsRow';
import SettingsToggle from '../../../../SettingsToggle';

type PermissionAction = 'allow' | 'ask' | 'deny';
type PermissionValue = PermissionAction | Record<string, PermissionAction>;

type OpenCodeAgent = {
  name: string;
  description: string;
  mode?: 'primary' | 'subagent' | 'all';
  model?: string;
  prompt?: string;
  temperature?: number;
  topP?: number;
  steps?: number;
  disable?: boolean;
  hidden?: boolean;
  color?: string;
  permission?: Record<string, PermissionValue>;
  tools?: Record<string, boolean>;
  options: Record<string, unknown>;
};

type AgentFormState = {
  originalName: string;
  name: string;
  description: string;
  mode: 'primary' | 'subagent' | 'all';
  model: string;
  prompt: string;
  temperature: string;
  topP: string;
  steps: string;
  disable: boolean;
  hidden: boolean;
  color: string;
  permissionJson: string;
  preservedLegacyTools?: Record<string, boolean>;
  optionsJson: string;
};

type ApiEnvelope<T> = {
  success: boolean;
  data?: T;
  error?: string | { message?: string };
};

// Pattern-capable permissions use an explicit wildcard rule so users can add
// narrower entries after it and rely on OpenCode's last-matching-rule behavior.
const DEFAULT_PERMISSION_JSON = JSON.stringify({
  read: { '*': 'allow' },
  edit: { '*': 'allow' },
  glob: { '*': 'allow' },
  grep: { '*': 'allow' },
  list: { '*': 'allow' },
  bash: { '*': 'allow' },
  task: { '*': 'allow' },
  external_directory: { '*': 'ask' },
  todowrite: 'allow',
  webfetch: 'allow',
  websearch: 'allow',
  lsp: { '*': 'allow' },
  skill: { '*': 'allow' },
  question: 'allow',
  doom_loop: 'allow',
}, null, 2);

const EMPTY_FORM: AgentFormState = {
  originalName: '',
  name: '',
  description: '',
  mode: 'all',
  model: '',
  prompt: '',
  temperature: '',
  topP: '',
  steps: '',
  disable: false,
  hidden: false,
  color: '',
  permissionJson: DEFAULT_PERMISSION_JSON,
  preservedLegacyTools: undefined,
  optionsJson: '{}',
};

const inputClassName = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary';
const labelClassName = 'mb-1.5 block text-sm font-medium text-foreground';
const helpClassName = 'mt-1 text-xs text-muted-foreground';

const getApiError = (payload: unknown, fallback: string): string => {
  if (!payload || typeof payload !== 'object') return fallback;
  const error = (payload as ApiEnvelope<unknown>).error;
  if (typeof error === 'string' && error) return error;
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message;
  return fallback;
};

const readApiEnvelope = async <T,>(response: Response): Promise<ApiEnvelope<T>> => {
  const contentType = response.headers.get('content-type') ?? '';
  const body = await response.text();
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error(
      `OpenCode agents API returned a non-JSON response (${response.status}). Restart the CloudCLI server and try again.`,
    );
  }

  try {
    return JSON.parse(body) as ApiEnvelope<T>;
  } catch {
    throw new Error(`OpenCode agents API returned invalid JSON (${response.status}).`);
  }
};

const parseJsonObject = (
  value: string,
  label: string,
  emptyValue: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!value.trim()) return emptyValue;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error instanceof Error ? error.message : 'parse failed'}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
};

const optionalNumber = (value: string, label: string): number | undefined => {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number.`);
  return parsed;
};

const formFromAgent = (agent: OpenCodeAgent): AgentFormState => ({
  originalName: agent.name,
  name: agent.name,
  description: agent.description,
  mode: agent.mode ?? 'all',
  model: agent.model ?? '',
  prompt: agent.prompt ?? '',
  temperature: agent.temperature === undefined ? '' : String(agent.temperature),
  topP: agent.topP === undefined ? '' : String(agent.topP),
  steps: agent.steps === undefined ? '' : String(agent.steps),
  disable: agent.disable ?? false,
  hidden: agent.hidden ?? false,
  color: agent.color ?? '',
  permissionJson: agent.permission ? JSON.stringify(agent.permission, null, 2) : '',
  preservedLegacyTools: agent.tools,
  optionsJson: JSON.stringify(agent.options ?? {}, null, 2),
});

export default function OpenCodeAgentsContent() {
  const [agents, setAgents] = useState<OpenCodeAgent[]>([]);
  const [form, setForm] = useState<AgentFormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const loadAgents = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await authenticatedFetch('/api/providers/opencode/agents');
      const payload = await readApiEnvelope<{ agents: OpenCodeAgent[] }>(response);
      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(getApiError(payload, 'Failed to load OpenCode agents.'));
      }
      setAgents(payload.data.agents ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load OpenCode agents.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  const updateForm = <K extends keyof AgentFormState>(key: K, value: AgentFormState[K]) => {
    setForm((current) => current ? { ...current, [key]: value } : current);
  };

  const openCreate = () => {
    setError('');
    setSuccess('');
    setForm({ ...EMPTY_FORM });
  };

  const openEdit = (agent: OpenCodeAgent) => {
    setError('');
    setSuccess('');
    setForm(formFromAgent(agent));
  };

  const saveAgent = async () => {
    if (!form) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const permission = parseJsonObject(form.permissionJson, 'Permissions', undefined);
      const options = parseJsonObject(form.optionsJson, 'Additional options', {}) ?? {};
      const payload = {
        name: form.name,
        ...(form.originalName ? { originalName: form.originalName } : {}),
        description: form.description,
        mode: form.mode,
        model: form.model || undefined,
        prompt: form.prompt || undefined,
        temperature: optionalNumber(form.temperature, 'Temperature'),
        topP: optionalNumber(form.topP, 'Top P'),
        steps: optionalNumber(form.steps, 'Max steps'),
        disable: form.disable,
        hidden: form.hidden,
        color: form.color || undefined,
        permission,
        tools: form.preservedLegacyTools,
        options,
      };
      const response = await authenticatedFetch('/api/providers/opencode/agents', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const responsePayload = await readApiEnvelope<{ agent: OpenCodeAgent }>(response);
      if (!response.ok || !responsePayload.success || !responsePayload.data) {
        throw new Error(getApiError(responsePayload, 'Failed to save OpenCode agent.'));
      }
      setAgents((current) => [
        ...current.filter((agent) => agent.name !== form.originalName && agent.name !== responsePayload.data!.agent.name),
        responsePayload.data!.agent,
      ].sort((left, right) => left.name.localeCompare(right.name)));
      setForm(null);
      setSuccess(`Saved global OpenCode agent “${responsePayload.data.agent.name}”.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save OpenCode agent.');
    } finally {
      setSaving(false);
    }
  };

  const deleteAgent = async (name: string) => {
    setError('');
    setSuccess('');
    try {
      const response = await authenticatedFetch(`/api/providers/opencode/agents/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
      const payload = await readApiEnvelope<{ removed: boolean }>(response);
      if (!response.ok || !payload.success) {
        throw new Error(getApiError(payload, 'Failed to delete OpenCode agent.'));
      }
      setAgents((current) => current.filter((agent) => agent.name !== name));
      setDeletingName(null);
      setSuccess(`Deleted global OpenCode agent “${name}”.`);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Failed to delete OpenCode agent.');
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
            <Bot className="h-4 w-4" /> Global OpenCode agents
          </h3>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Manage agents shared by every project. Changes are written only to the global
            <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">~/.config/opencode/opencode.json</code>
            configuration.
          </p>
          <a
            href="https://opencode.ai/docs/agents/"
            target="_blank"
            rel="noreferrer"
            className="mt-1.5 inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            OpenCode agent documentation <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        {!form && (
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" /> Add agent
          </button>
        )}
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      )}
      {success && !error && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          {success}
        </div>
      )}

      {form ? (
        <div className="space-y-4">
          <SettingsCard className="p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h4 className="font-medium text-foreground">{form.originalName ? 'Edit agent' : 'New agent'}</h4>
                <p className="text-xs text-muted-foreground">Fields left blank use OpenCode or model defaults.</p>
              </div>
              <button type="button" onClick={() => setForm(null)} className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close agent editor">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label>
                <span className={labelClassName}>Name *</span>
                <input className={inputClassName} value={form.name} maxLength={120} placeholder="code-reviewer" onChange={(event) => updateForm('name', event.target.value)} />
                <span className={helpClassName}>Letters, numbers, dots, underscores, and hyphens.</span>
              </label>
              <label>
                <span className={labelClassName}>Mode</span>
                <select className={inputClassName} value={form.mode} onChange={(event) => updateForm('mode', event.target.value as AgentFormState['mode'])}>
                  <option value="all">All (primary and subagent)</option>
                  <option value="primary">Primary</option>
                  <option value="subagent">Subagent</option>
                </select>
              </label>
              <label className="md:col-span-2">
                <span className={labelClassName}>Description *</span>
                <input className={inputClassName} value={form.description} maxLength={2000} placeholder="Reviews code for quality and security issues" onChange={(event) => updateForm('description', event.target.value)} />
                <span className={helpClassName}>Tells OpenCode when this agent should be used.</span>
              </label>
              <label>
                <span className={labelClassName}>Model</span>
                <input className={inputClassName} value={form.model} placeholder="provider/model-id" onChange={(event) => updateForm('model', event.target.value)} />
              </label>
              <label>
                <span className={labelClassName}>Color</span>
                <input className={inputClassName} value={form.color} placeholder="#ff6b6b or accent" onChange={(event) => updateForm('color', event.target.value)} />
                <span className={helpClassName}>Hex or primary, secondary, accent, success, warning, error, info.</span>
              </label>
              <label className="md:col-span-2">
                <span className={labelClassName}>System prompt</span>
                <textarea className={`${inputClassName} min-h-32 resize-y font-mono`} value={form.prompt} placeholder="Agent instructions or {file:./prompts/review.txt}" onChange={(event) => updateForm('prompt', event.target.value)} />
              </label>
            </div>
          </SettingsCard>

          <SettingsCard className="p-4">
            <h4 className="mb-3 font-medium text-foreground">Sampling and limits</h4>
            <div className="grid gap-4 sm:grid-cols-3">
              <label>
                <span className={labelClassName}>Temperature</span>
                <input type="number" min="0" max="1" step="0.01" className={inputClassName} value={form.temperature} placeholder="Model default" onChange={(event) => updateForm('temperature', event.target.value)} />
              </label>
              <label>
                <span className={labelClassName}>Top P</span>
                <input type="number" min="0" max="1" step="0.01" className={inputClassName} value={form.topP} placeholder="Model default" onChange={(event) => updateForm('topP', event.target.value)} />
              </label>
              <label>
                <span className={labelClassName}>Max steps</span>
                <input type="number" min="1" step="1" className={inputClassName} value={form.steps} placeholder="Unlimited" onChange={(event) => updateForm('steps', event.target.value)} />
              </label>
            </div>
          </SettingsCard>

          <SettingsCard divided>
            <SettingsRow label="Disabled" description="Keep this definition in config but prevent OpenCode from using it.">
              <SettingsToggle checked={form.disable} onChange={(value) => updateForm('disable', value)} ariaLabel="Disable agent" />
            </SettingsRow>
            <SettingsRow label="Hidden" description="Hide a subagent from @ autocomplete; Task can still invoke it.">
              <SettingsToggle checked={form.hidden} onChange={(value) => updateForm('hidden', value)} ariaLabel="Hide agent" disabled={form.mode !== 'subagent'} />
            </SettingsRow>
          </SettingsCard>

          <SettingsCard className="p-4">
            <div>
              <h4 className="font-medium text-foreground">Permissions</h4>
              <p className="mt-1 text-xs text-muted-foreground">
                JSON supports allow/ask/deny plus ordered pattern rules. Keys include read, edit, glob, grep,
                list, bash, task, external_directory, todowrite, webfetch, websearch, lsp, skill, question,
                doom_loop, custom tools, and MCP tool patterns. New agents default documented permissions to
                allow, except external_directory, which defaults to ask. Wildcard rules are listed first so
                more specific rules can be appended after them.
              </p>
              <textarea
                className={`${inputClassName} mt-3 min-h-[34rem] resize-y font-mono`}
                value={form.permissionJson}
                spellCheck={false}
                placeholder={'{\n  "edit": "deny",\n  "bash": { "*": "allow", "git push*": "ask" }\n}'}
                onChange={(event) => updateForm('permissionJson', event.target.value)}
              />
            </div>
          </SettingsCard>

          <SettingsCard className="p-4">
            <h4 className="font-medium text-foreground">Additional provider/model options</h4>
            <p className="mt-1 text-xs text-muted-foreground">
              Any extra JSON fields are passed directly to the model provider, such as
              <code className="mx-1 rounded bg-muted px-1">reasoningEffort</code> or
              <code className="mx-1 rounded bg-muted px-1">textVerbosity</code>. Deprecated fields such as
              <code className="mx-1 rounded bg-muted px-1">maxSteps</code> can also be represented here.
            </p>
            <textarea
              className={`${inputClassName} mt-3 min-h-36 resize-y font-mono`}
              value={form.optionsJson}
              spellCheck={false}
              placeholder={'{\n  "reasoningEffort": "high",\n  "textVerbosity": "low"\n}'}
              onChange={(event) => updateForm('optionsJson', event.target.value)}
            />
          </SettingsCard>

          <div className="flex justify-end gap-2 pb-2">
            <button type="button" onClick={() => setForm(null)} disabled={saving} className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50">
              Cancel
            </button>
            <button type="button" onClick={() => void saveAgent()} disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save global agent
            </button>
          </div>
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading global agents…
        </div>
      ) : agents.length === 0 ? (
        <SettingsCard className="flex flex-col items-center px-4 py-12 text-center">
          <Bot className="mb-3 h-9 w-9 text-muted-foreground" />
          <h4 className="font-medium text-foreground">No global agents configured</h4>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">Create an OpenCode agent that will be available in every project.</p>
          <button type="button" onClick={openCreate} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            <Plus className="h-4 w-4" /> Add agent
          </button>
        </SettingsCard>
      ) : (
        <div className="space-y-2">
          {agents.map((agent) => (
            <SettingsCard key={agent.name} className="p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-foreground">{agent.name}</span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{agent.mode ?? 'all'}</span>
                    {agent.disable && <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">disabled</span>}
                    {agent.hidden && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">hidden</span>}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{agent.description || 'No description configured'}</p>
                  {agent.model && <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{agent.model}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {deletingName === agent.name ? (
                    <>
                      <span className="mr-1 text-xs text-destructive">Delete?</span>
                      <button type="button" onClick={() => void deleteAgent(agent.name)} className="rounded-md bg-destructive px-2.5 py-1.5 text-xs font-medium text-destructive-foreground">Confirm</button>
                      <button type="button" onClick={() => setDeletingName(null)} className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted">Cancel</button>
                    </>
                  ) : (
                    <>
                      <button type="button" onClick={() => openEdit(agent)} className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Edit ${agent.name}`}><Pencil className="h-4 w-4" /></button>
                      <button type="button" onClick={() => setDeletingName(agent.name)} className="rounded-md p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label={`Delete ${agent.name}`}><Trash2 className="h-4 w-4" /></button>
                    </>
                  )}
                </div>
              </div>
            </SettingsCard>
          ))}
        </div>
      )}
    </div>
  );
}
