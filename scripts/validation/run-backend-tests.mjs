import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Audited emitted membership. Files are duration-balanced across isolated workers;
// each Node test child still gives every test file its own process and database.
export const backendTestPartitions = [
  [
    'dist-server/server/modules/providers/tests/sessions-status.routes.test.js',
    'dist-server/server/modules/providers/tests/claude-auth.test.js', 'dist-server/server/modules/providers/tests/opencode-agents.test.js',
    'dist-server/server/modules/projects/tests/project-clone.service.test.js', 'dist-server/server/modules/worktrees/tests/worktree-create.service.test.js',
    'dist-server/server/modules/git/tests/git.test.js', 'dist-server/server/shared/tests/request-correlation.test.js',
  ],
  [
    'dist-server/server/modules/providers/tests/sessions.service.test.js',
    'dist-server/server/modules/providers/tests/opencode-models.test.js', 'dist-server/server/modules/providers/tests/provider-models.service.test.js',
    'dist-server/server/modules/projects/tests/project-management.service.test.js', 'dist-server/server/modules/worktrees/tests/worktree-merge.service.test.js',
    'dist-server/server/modules/file-tree/tests/file-tree.service.test.js', 'dist-server/server/shared/tests/image-attachments.test.js',
  ],
  [
    'dist-server/server/modules/database/tests/sessions-provider-mapping.test.js',
    'dist-server/server/modules/providers/tests/opencode-runtime.test.js', 'dist-server/server/modules/providers/tests/provider-token-usage.service.test.js',
    'dist-server/server/modules/projects/tests/projects-with-sessions-fetch.service.test.js', 'dist-server/server/modules/websocket/tests/shell-websocket.service.test.js',
    'dist-server/server/modules/git/tests/git-repository.service.test.js', 'dist-server/server/shared/tests/workspace-path-validation.test.js',
  ],
  [
    'dist-server/server/modules/providers/tests/opencode-sessions.test.js', 'dist-server/server/modules/providers/tests/sessions-details.test.js',
    'dist-server/server/modules/providers/tests/provider-runtime.service.test.js', 'dist-server/server/modules/notifications/tests/notification-orchestrator.integration.test.js',
    'dist-server/server/modules/websocket/tests/opencode-run-recovery.test.js',
    'dist-server/server/shared/tests/claude-cli-path.test.js',
  ],
  [
    'dist-server/server/modules/websocket/tests/chat-run-registry.test.js', 'dist-server/server/modules/database/tests/session-run-state.db.test.js',
    'dist-server/server/modules/providers/tests/codex-sessions.test.js', 'dist-server/server/modules/providers/tests/session-mutations.routes.test.js',
    'dist-server/server/modules/worktrees/tests/worktree-create-and-open.service.test.js', 'dist-server/server/modules/settings/tests/settings.service.test.js',
    'dist-server/server/modules/cli/tests/cli.service.test.js', 'dist-server/server/modules/auth/tests/auth.service.test.js',
    'dist-server/server/shared/tests/slice-tail-page.test.js',
  ],
  [
    'dist-server/server/modules/websocket/tests/chat-run-lifecycle.test.js', 'dist-server/server/modules/database/tests/appointments.db.test.js',
    'dist-server/server/modules/providers/tests/claude-sessions.test.js', 'dist-server/server/modules/providers/tests/sessions-history.routes.test.js',
    'dist-server/server/modules/worktrees/tests/worktree-git.service.test.js', 'dist-server/server/modules/settings/tests/docker-management.service.test.js',
    'dist-server/server/modules/cli/tests/sandbox.service.test.js', 'dist-server/server/modules/assets/tests/image-assets.service.test.js',
  ],
  [
    'dist-server/server/modules/database/tests/sessions.db.integration.test.js', 'dist-server/server/modules/database/tests/projects.db.integration.test.js',
    'dist-server/server/modules/providers/tests/opencode-activity-inspector.test.js', 'dist-server/server/modules/providers/tests/sessions-manifest.routes.test.js',
    'dist-server/server/modules/worktrees/tests/worktree-list.service.test.js',
    'dist-server/server/modules/browser-use/tests/browser-use.service.test.js', 'dist-server/server/modules/appointments/tests/appointment-scheduler.service.test.js',
    'dist-server/server/modules/projects/tests/project-star.service.test.js', 'dist-server/server/modules/voice/tests/voice.service.test.js',
  ],
  [
    'dist-server/server/modules/database/tests/mutation-receipts.db.test.js', 'dist-server/server/modules/providers/tests/codex-models.test.js',
    'dist-server/server/modules/providers/tests/mcp.test.js', 'dist-server/server/modules/providers/tests/opencode-token-usage.test.js',
    'dist-server/server/modules/providers/tests/provider-attachment-history.test.js', 'dist-server/server/modules/providers/tests/skills.test.js',
    'dist-server/server/modules/websocket/tests/chat-attachment-filter.test.js', 'dist-server/server/modules/websocket/tests/websocket-heartbeat.service.test.js',
    'dist-server/server/modules/worktrees/tests/worktree-open.service.test.js', 'dist-server/server/modules/worktrees/tests/worktree-remove.service.test.js',
    'dist-server/server/modules/worktrees/tests/worktrees.routes.test.js', 'dist-server/server/modules/file-tree/tests/file-tree.routes.test.js',
    'dist-server/server/modules/git/tests/git-init.routes.test.js', 'dist-server/server/modules/plugins/tests/plugins.service.test.js',
    'dist-server/server/modules/system/tests/system.service.test.js',
    'dist-server/server/modules/user/tests/user.service.test.js', 'dist-server/server/modules/commands/tests/commands.test.js',
    'dist-server/server/modules/appointments/tests/appointments.routes.test.js',
  ],
  ['dist-server/server/modules/agent/tests/agent.routes.test.js'],
];

async function emittedTests(directory = 'dist-server/server') {
  const result = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.name.endsWith('.test.js')) result.push(child.split(path.sep).join('/'));
    }
  }
  await visit(directory); return result.sort();
}

export async function auditBackendTestMembership(partitions = backendTestPartitions) {
  const listed = partitions.flat(); const duplicates = listed.filter((file, index) => listed.indexOf(file) !== index);
  const emitted = await emittedTests(); const listedSet = new Set(listed);
  const missing = emitted.filter((file) => !listedSet.has(file)); const stale = listed.filter((file) => !emitted.includes(file));
  if (duplicates.length || missing.length || stale.length) throw new Error(`backend test membership mismatch\nduplicates: ${duplicates.join(', ') || 'none'}\nmissing: ${missing.join(', ') || 'none'}\nstale: ${stale.join(', ') || 'none'}`);
  return listed.length;
}

function runPartition(files, index) {
  return new Promise((resolve) => {
    const isolation = files.length === 1 ? ['--test-isolation=none'] : [];
    const child = spawn(process.execPath, ['--test', ...isolation, '--test-reporter=tap', ...files], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => resolve({ index, code: 1, stdout, stderr: `${stderr}${error.stack ?? error}\n` }));
    child.once('exit', (code, signal) => resolve({ index, code: code ?? 1, signal, stdout, stderr }));
  });
}

export function parseTapCounts(text) {
  const count = (name) => Number(text.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? 0);
  return { tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped') };
}

export async function runBackendTests() {
  const files = await auditBackendTestMembership(); const results = await Promise.all(backendTestPartitions.map(runPartition));
  const totals = results.reduce((sum, result) => { const counts = parseTapCounts(result.stdout); for (const key of Object.keys(sum)) sum[key] += counts[key]; return sum; }, { tests: 0, passed: 0, failed: 0, skipped: 0 });
  const failures = results.filter((result) => result.code !== 0 || result.signal);
  if (failures.length) for (const result of failures) process.stderr.write(`backend partition ${result.index + 1} failed (${result.signal ?? `exit ${result.code}`})\n${result.stdout}${result.stderr}`);
  process.stdout.write(`# files ${files}\n# tests ${totals.tests}\n# pass ${totals.passed}\n# fail ${totals.failed}\n# skipped ${totals.skipped}\n`);
  return failures.length || totals.tests < 441 || totals.failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await runBackendTests();
