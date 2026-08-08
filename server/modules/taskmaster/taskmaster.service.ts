import type { SpawnOptions } from 'node:child_process';
import path from 'node:path';

import type spawn from 'cross-spawn';

type TaskmasterServiceDependencies = {
    readTextFile(filePath: string): Promise<string>;
    getHomeDirectory(): string;
    accessFile(filePath: string, mode?: number): Promise<void>;
    environment: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    spawnProcess: typeof spawn;
};

type ProcessResult = {
    code: number | null;
    error: Error | null;
    stdout: string;
};

function runProcess(
    spawnProcess: typeof spawn,
    command: string,
    args: string[],
    options: SpawnOptions,
): Promise<ProcessResult> {
    return new Promise((resolve) => {
        const child = spawnProcess(command, args, options);
        let stdout = '';
        let settled = false;

        child.stdout?.on('data', (data) => {
            stdout += data.toString();
        });

        const settle = (code: number | null, error: Error | null = null) => {
            if (settled) return;
            settled = true;
            resolve({ code, error, stdout });
        };

        child.once('error', (error) => settle(null, error));
        child.once('close', (code) => settle(code));
    });
}

/**
 * Creates TaskMaster status workflows for the TaskMaster composition root.
 * The returned service is consumed by TaskMaster routes so filesystem and
 * environment access remain explicit production dependencies.
 */
export function createTaskmasterService(dependencies: TaskmasterServiceDependencies) {
    return {
        /** Probes the TaskMaster CLI directly without invoking a generic command shell. */
        async checkInstallation() {
            const pathValue = dependencies.environment.PATH ?? '';
            const executableNames = dependencies.platform === 'win32'
                ? (dependencies.environment.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
                    .split(';')
                    .filter(Boolean)
                    .map((extension) => `task-master${extension.toLowerCase()}`)
                : ['task-master'];
            let installPath: string | null = null;

            for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
                for (const executableName of executableNames) {
                    const candidatePath = path.join(directory, executableName);
                    try {
                        await dependencies.accessFile(candidatePath);
                        installPath = candidatePath;
                        break;
                    } catch {
                        // Continue through PATH/PATHEXT until an executable shim is found.
                    }
                }
                if (installPath) break;
            }

            if (!installPath) {
                return {
                    isInstalled: false,
                    installPath: null,
                    version: null,
                    reason: 'TaskMaster CLI not found in PATH',
                };
            }

            const versionResult = await runProcess(
                dependencies.spawnProcess,
                installPath,
                ['--version'],
                { stdio: ['ignore', 'pipe', 'pipe'], shell: false },
            );

            return {
                isInstalled: true,
                installPath,
                version: versionResult.code === 0 ? versionResult.stdout.trim() : 'unknown',
                reason: null,
            };
        },
        /** Detects TaskMaster in the user's Claude MCP configuration without exposing secret values. */
        async detectMcpServer() {
            const homeDirectory = dependencies.getHomeDirectory();
            const configurationPaths = [
                path.join(homeDirectory, '.claude.json'),
                path.join(homeDirectory, '.claude', 'settings.json'),
            ];
            let configuration: Record<string, unknown> | null = null;
            let configurationPath: string | null = null;

            for (const candidatePath of configurationPaths) {
                try {
                    const parsedConfiguration = JSON.parse(
                        await dependencies.readTextFile(candidatePath),
                    ) as unknown;
                    if (typeof parsedConfiguration === 'object' && parsedConfiguration !== null) {
                        configuration = parsedConfiguration as Record<string, unknown>;
                        configurationPath = candidatePath;
                        break;
                    }
                } catch {
                    // A missing or malformed candidate must not prevent checking the fallback file.
                }
            }

            if (!configuration) {
                return {
                    hasMCPServer: false,
                    reason: 'No Claude configuration file found',
                    hasConfig: false,
                };
            }

            const serverGroups: Array<{
                scope: string;
                projectPath?: string;
                servers: Record<string, unknown>;
            }> = [];

            if (typeof configuration.mcpServers === 'object' && configuration.mcpServers !== null) {
                serverGroups.push({
                    scope: 'user',
                    servers: configuration.mcpServers as Record<string, unknown>,
                });
            }

            if (typeof configuration.projects === 'object' && configuration.projects !== null) {
                for (const [projectPath, projectValue] of Object.entries(configuration.projects)) {
                    const projectConfiguration = typeof projectValue === 'object' && projectValue !== null
                        ? projectValue as Record<string, unknown>
                        : {};

                    if (
                        typeof projectConfiguration.mcpServers === 'object'
                        && projectConfiguration.mcpServers !== null
                    ) {
                        serverGroups.push({
                            scope: 'local',
                            projectPath,
                            servers: projectConfiguration.mcpServers as Record<string, unknown>,
                        });
                    }
                }
            }

            for (const serverGroup of serverGroups) {
                for (const [serverName, serverValue] of Object.entries(serverGroup.servers)) {
                    const serverConfiguration = typeof serverValue === 'object' && serverValue !== null
                        ? serverValue as Record<string, unknown>
                        : {};
                    const command = typeof serverConfiguration.command === 'string'
                        ? serverConfiguration.command
                        : null;
                    const url = typeof serverConfiguration.url === 'string'
                        ? serverConfiguration.url
                        : null;
                    const isTaskmasterServer = serverName === 'task-master-ai'
                        || serverName.includes('task-master')
                        || command?.includes('task-master');

                    if (!isTaskmasterServer) {
                        continue;
                    }

                    const environmentVariables = (
                        typeof serverConfiguration.env === 'object'
                        && serverConfiguration.env !== null
                    )
                        ? serverConfiguration.env as Record<string, unknown>
                        : {};

                    return {
                        hasMCPServer: true,
                        isConfigured: Boolean(command || url),
                        hasApiKeys: Object.keys(environmentVariables).length > 0,
                        scope: serverGroup.scope,
                        ...(serverGroup.projectPath ? { projectPath: serverGroup.projectPath } : {}),
                        config: {
                            command,
                            args: Array.isArray(serverConfiguration.args) ? serverConfiguration.args : [],
                            url,
                            envVars: Object.keys(environmentVariables),
                            type: command ? 'stdio' : url ? 'http' : 'unknown',
                        },
                    };
                }
            }

            return {
                hasMCPServer: false,
                reason: 'task-master-ai not found in configured MCP servers',
                hasConfig: true,
                configPath: configurationPath,
                availableServers: serverGroups.flatMap((serverGroup) => Object.keys(serverGroup.servers)),
            };
        },
    };
}
