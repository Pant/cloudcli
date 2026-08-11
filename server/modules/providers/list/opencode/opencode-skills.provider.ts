import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type {
  ProviderSkill,
  ProviderSkillAccessUpdateInput,
  ProviderSkillAccessUpdateResult,
  ProviderSkillListOptions,
  ProviderSkillSource,
} from '@/shared/types.js';
import {
  addUniqueProviderSkillSource,
  AppError,
  findTopmostGitRoot,
  readObjectRecord,
} from '@/shared/utils.js';

import { OpenCodeConfigStore } from './opencode-config.provider.js';

const OPENCODE_PROJECT_SKILL_DIRS = [
  ['.opencode', 'skills'],
  ['.claude', 'skills'],
  ['.agents', 'skills'],
];

const OPENCODE_USER_SKILL_DIRS = [
  ['.config', 'opencode', 'skills'],
  ['.claude', 'skills'],
  ['.agents', 'skills'],
];

export class OpenCodeSkillsProvider extends SkillsProvider {
  constructor(private readonly configStore: OpenCodeConfigStore) {
    super('opencode');
  }

  async listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]> {
    const skills = await super.listSkills(options);
    const userConfig = await this.configStore.readConfig('user');
    const projectConfig = options?.workspacePath
      ? await this.configStore.readConfig('project', options.workspacePath)
      : null;
    return skills.map((skill) => ({
      ...skill,
      enabled: this.resolveEnabled(skill.name, userConfig, projectConfig),
    }));
  }

  async updateSkillAccess(input: ProviderSkillAccessUpdateInput): Promise<ProviderSkillAccessUpdateResult> {
    const name = input.name.trim();
    if (!name) {
      throw new AppError('Skill name is required.', { code: 'PROVIDER_SKILL_NAME_REQUIRED', statusCode: 400 });
    }
    if (input.scope === 'project' && !input.workspacePath?.trim()) {
      throw new AppError('workspacePath is required for project skill access updates.', {
        code: 'PROVIDER_SKILL_WORKSPACE_REQUIRED',
        statusCode: 400,
      });
    }
    const access = input.enabled ? 'allow' : 'deny';
    await this.configStore.updateConfig(input.scope, input.workspacePath ?? '', (config) => {
      const permission = readObjectRecord(config.permission) ?? {};
      const skill = readObjectRecord(permission.skill) ?? {};
      delete skill[name];
      permission.skill = { ...skill, [name]: access };
      config.permission = permission;
    });
    return { provider: 'opencode', name, enabled: input.enabled, access, scope: input.scope };
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    const sources: ProviderSkillSource[] = [];
    const seenRootDirs = new Set<string>();
    const repoRoot = await findTopmostGitRoot(workspacePath);

    for (const projectRoot of this.getProjectSearchRoots(workspacePath, repoRoot)) {
      for (const skillDir of OPENCODE_PROJECT_SKILL_DIRS) {
        // OpenCode intentionally reads Claude and Agents skill folders so users
        // can reuse the same skill libraries across compatible coding agents.
        addUniqueProviderSkillSource(sources, seenRootDirs, {
          scope: 'project',
          rootDir: path.join(projectRoot, ...skillDir),
          commandPrefix: '/',
          recursive: true,
        });
      }
    }

    for (const skillDir of OPENCODE_USER_SKILL_DIRS) {
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'user',
        rootDir: path.join(os.homedir(), ...skillDir),
        commandPrefix: '/',
        recursive: true,
      });
    }

    return sources;
  }

  private resolveEnabled(
    name: string,
    userConfig: Record<string, unknown>,
    projectConfig: Record<string, unknown> | null,
  ): boolean {
    let decision: unknown = 'allow';
    for (const config of [userConfig, projectConfig]) {
      const rules = readObjectRecord(readObjectRecord(config?.permission)?.skill);
      if (!rules) continue;
      for (const [pattern, access] of Object.entries(rules)) {
        const expression = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
        if (expression.test(name) && (access === 'allow' || access === 'ask' || access === 'deny')) {
          decision = access;
        }
      }
    }
    return decision !== 'deny';
  }

  private getProjectSearchRoots(workspacePath: string, repoRoot: string | null): string[] {
    const roots: string[] = [];
    const normalizedWorkspacePath = path.resolve(workspacePath);
    const normalizedRepoRoot = repoRoot ? path.resolve(repoRoot) : null;
    let currentPath = normalizedWorkspacePath;

    while (true) {
      roots.push(currentPath);
      if (!normalizedRepoRoot || currentPath === normalizedRepoRoot) {
        break;
      }

      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        break;
      }

      currentPath = parentPath;
    }

    return roots;
  }
}
