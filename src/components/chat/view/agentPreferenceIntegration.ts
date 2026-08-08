export async function persistOpenCodePreferenceChange(options: {
  agent: string;
  patch: { model?: string; reasoningEffort?: string };
  updateAgentPreferences: (agent: string, patch: { model?: string; reasoningEffort?: string }) => Promise<{ model?: string; reasoningEffort: string }>;
  persistSessionModel?: (model: string) => Promise<unknown>;
  patchQueuedOptions: (patch: { model?: string; effort?: string; agent?: string }) => void;
  isCurrent: () => boolean;
}): Promise<{ model?: string; reasoningEffort: string } | null> {
  const preference = await options.updateAgentPreferences(options.agent, options.patch);
  if (!options.isCurrent()) return null;
  if (options.patch.model && preference.model && options.persistSessionModel) {
    await options.persistSessionModel(preference.model);
    if (!options.isCurrent()) return null;
  }
  options.patchQueuedOptions({
    agent: options.agent,
    ...(options.patch.model && preference.model ? { model: preference.model } : {}),
    ...(options.patch.reasoningEffort ? { effort: preference.reasoningEffort } : {}),
  });
  return preference;
}
