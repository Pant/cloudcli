import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileCode2, Loader2, RefreshCw, Search } from 'lucide-react';

import { cn } from '../../../../lib/utils';
import { Badge, Button, Input } from '../../../../shared/view/ui';
import {
  createProjectTargets,
  fetchOpenCodeSkills,
  mutateOpenCodeSkillAccess,
} from '../../../skills/hooks/useProviderSkills';
import type { ProviderSkill } from '../../../skills/types';
import type { SettingsProject } from '../../types/types';
import SettingsToggle from '../SettingsToggle';

type Props = { projects: SettingsProject[] };

export default function SkillsSettingsTab({ projects }: Props) {
  const targets = useMemo(() => createProjectTargets(projects.map((project) => ({
    projectId: project.name,
    displayName: project.displayName || project.name,
    fullPath: project.fullPath,
    path: project.path,
  }))), [projects]);
  const [targetPath, setTargetPath] = useState('');
  const [skills, setSkills] = useState<ProviderSkill[]>([]);
  const [query, setQuery] = useState('');
  const [pendingNames, setPendingNames] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const selectedProject = targets.find((target) => target.path === targetPath);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const normalized = (await fetchOpenCodeSkills(selectedProject)).filter((skill) => selectedProject || skill.scope === 'user');
      setSkills(normalized.map((skill) => selectedProject && (skill.scope === 'project' || skill.scope === 'repo')
        ? { ...skill, projectDisplayName: selectedProject.displayName, projectPath: selectedProject.path }
        : skill));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load OpenCode skills');
    } finally {
      setLoading(false);
    }
  }, [selectedProject]);

  useEffect(() => { void load(); }, [load]);

  const toggle = async (skill: ProviderSkill, enabled: boolean) => {
    setPendingNames((current) => new Set(current).add(skill.name));
    setError(null);
    try {
      await mutateOpenCodeSkillAccess({
        skill,
        enabled,
        project: selectedProject,
        skills,
        onUpdated: setSkills,
        refetch: async () => { await load(); return []; },
      });
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : 'Failed to update skill access');
    } finally {
      setPendingNames((current) => {
        const next = new Set(current); next.delete(skill.name); return next;
      });
    }
  };

  const filtered = skills.filter((skill) => [skill.name, skill.description, skill.sourcePath, skill.scope]
    .some((value) => value.toLowerCase().includes(query.trim().toLowerCase())));

  return <div className="space-y-4">
    <div className="flex items-start gap-3"><FileCode2 className="mt-1 h-5 w-5 text-muted-foreground" /><div><h3 className="text-lg font-medium">OpenCode Skills</h3><p className="text-sm text-muted-foreground">Manage effective skill access globally or for a CloudCLI project.</p></div></div>
    <div className="flex flex-col gap-2 sm:flex-row">
      <select aria-label="Skill target" value={targetPath} onChange={(event) => setTargetPath(event.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
        <option value="">Global</option>{targets.map((target) => <option key={target.path} value={target.path}>{target.displayName} — {target.path}</option>)}
      </select>
      <div className="relative flex-1"><Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input aria-label="Search OpenCode skills" value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9" placeholder="Search skills..." /></div>
      <Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}><RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />Refresh</Button>
    </div>
    {error && <div role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">{error}</div>}
    {loading && skills.length === 0 ? <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin" /></div> : <div className="grid gap-3 lg:grid-cols-2">{filtered.map((skill) => <div key={`${skill.sourcePath}:${skill.projectPath || 'global'}`} className="rounded-lg border border-border bg-card/50 p-4">
      <div className="flex gap-3"><div className="min-w-0 flex-1"><div className="font-medium">{skill.name}</div><p className="mt-1 text-sm text-muted-foreground">{skill.description || 'No description provided.'}</p></div><SettingsToggle checked={skill.enabled} disabled={pendingNames.has(skill.name)} onChange={(enabled) => void toggle(skill, enabled)} ariaLabel={`${skill.enabled ? 'Disable' : 'Enable'} ${skill.name}`} /></div>
      <div className="mt-3 flex flex-wrap gap-2"><Badge variant="outline">{skill.scope}</Badge><Badge variant="outline">{selectedProject ? `Project: ${selectedProject.displayName}` : 'Global'}</Badge>{pendingNames.has(skill.name) && <Badge variant="outline">Updating…</Badge>}</div>
      <code className="mt-3 block break-all rounded-md bg-muted/30 p-2 text-xs">{skill.sourcePath}</code>
    </div>)}</div>}
    {!loading && filtered.length === 0 && <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">No matching skills.</div>}
  </div>;
}
