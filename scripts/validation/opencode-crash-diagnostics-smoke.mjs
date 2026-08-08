import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-opencode-crash-smoke-'));
const binRoot = path.join(fixtureRoot, 'bin');
const diagnosticRoot = path.join(fixtureRoot, 'diagnostics');
const cgroupRoot = path.join(fixtureRoot, 'cgroup');
const workspaceRoot = path.join(fixtureRoot, 'workspace');
const databasePath = path.join(fixtureRoot, 'cloudcli.db');
const prompt = 'SMOKE-PROMPT-MUST-NOT-PERSIST';
const markerSecret = 'SMOKE-ENV-SECRET-MUST-NOT-PERSIST';
const originalEnvironment = { ...process.env };

class SmokeConnection {
  readyState = 1;
  frames = [];
  send(data) { this.frames.push(JSON.parse(data)); }
}

async function waitFor(check, description) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

try {
  await Promise.all([
    mkdir(binRoot, { recursive: true }),
    mkdir(diagnosticRoot, { recursive: true }),
    mkdir(cgroupRoot, { recursive: true }),
    mkdir(workspaceRoot, { recursive: true }),
  ]);
  // Pre-create the isolated database so legacy/live database migration is never consulted.
  await writeFile(databasePath, '');
  await Promise.all([
    writeFile(path.join(cgroupRoot, 'memory.current'), '4096\n'),
    writeFile(path.join(cgroupRoot, 'memory.peak'), '8192\n'),
    writeFile(path.join(cgroupRoot, 'memory.events'), 'oom 1\noom_kill 1\n'),
    writeFile(path.join(cgroupRoot, 'memory.stat'), 'anon 2048\n'),
  ]);
  const staleDirectory = path.join(diagnosticRoot, 'stale-artifact');
  await mkdir(staleDirectory);
  await writeFile(path.join(staleDirectory, 'marker'), 'outside-retention-candidate');
  const oldTime = new Date(0);
  await import('node:fs/promises').then(({ utimes }) => utimes(staleDirectory, oldTime, oldTime));

  const fakeScript = path.join(binRoot, 'opencode-smoke.cjs');
  await writeFile(fakeScript, `
process.stdout.write(JSON.stringify({ type: 'text', sessionID: 'fake-native-session', text: 'smoke-json-output' }) + '\\n');
process.stderr.write('smoke-stderr-evidence');
process.exit(17);
`);
  if (process.platform === 'win32') {
    await writeFile(path.join(binRoot, 'opencode.cmd'), '@echo off\r\nnode "%~dp0opencode-smoke.cjs" %*\r\n');
  } else {
    const executable = path.join(binRoot, 'opencode');
    await writeFile(executable, '#!/bin/sh\nexec node "$(dirname "$0")/opencode-smoke.cjs" "$@"\n');
    await chmod(executable, 0o755);
  }

  process.env.DATABASE_PATH = databasePath;
  process.env.CLOUDCLI_OPENCODE_DIAGNOSTIC_ROOT = diagnosticRoot;
  process.env.CLOUDCLI_OPENCODE_DIAGNOSTIC_RETENTION_COUNT = '2';
  process.env.CLOUDCLI_OPENCODE_STDERR_TAIL_BYTES = '64';
  process.env.CLOUDCLI_CGROUP_V2_ROOT = cgroupRoot;
  process.env.OPENCODE_SMOKE_MARKER_SECRET = markerSecret;
  process.env.PATH = `${binRoot}${path.delimiter}${originalEnvironment.PATH ?? ''}`;
  if (process.platform === 'win32') process.env.PATHEXT = `.CMD;${originalEnvironment.PATHEXT ?? ''}`;

  const { closeConnection, initializeDatabase, sessionRunStateDb, sessionsDb } = await import('../../server/modules/database/index.ts');
  const { chatRunLifecycleService } = await import('../../server/modules/websocket/services/chat-run-lifecycle.service.ts');
  const { chatRunRegistry } = await import('../../server/modules/websocket/services/chat-run-registry.service.ts');
  await initializeDatabase();
  sessionsDb.createAppSession('diagnostics-smoke', 'opencode', workspaceRoot);

  const firstConnection = new SmokeConnection();
  await chatRunLifecycleService.start({ sessionId: 'diagnostics-smoke', command: prompt, connection: firstConnection });
  const firstHistory = await waitFor(() => sessionRunStateDb.listRecentHistory(10, 'diagnostics-smoke')[0], 'first history row');
  assert.equal(firstHistory.generation, 1);
  assert.equal(firstHistory.exitCode, 17);
  assert.equal(firstHistory.lifecycleState, 'failed');
  assert.match(firstHistory.stderrTail, /smoke-stderr-evidence/);
  assert.ok(firstHistory.diagnostic);
  assert.equal(path.isAbsolute(firstHistory.diagnostic.relativePath), false);
  assert.equal(firstHistory.diagnostic.relativePath.includes('..'), false);
  if (process.platform === 'linux') {
    assert.equal(firstHistory.resources?.end?.memoryPeakBytes, 8192);
    assert.equal(firstHistory.resources?.end?.memoryEvents?.oom_kill, 1);
  }

  const firstArtifact = path.join(diagnosticRoot, firstHistory.diagnostic.relativePath);
  const [stdout, stderr, metadata] = await Promise.all([
    readFile(path.join(firstArtifact, 'stdout.log'), 'utf8'),
    readFile(path.join(firstArtifact, 'stderr.log'), 'utf8'),
    readFile(path.join(firstArtifact, 'metadata.json'), 'utf8'),
  ]);
  assert.match(stdout, /smoke-json-output/);
  assert.equal(stderr, 'smoke-stderr-evidence');
  assert.ok(Buffer.byteLength(firstHistory.stderrTail) <= 64);
  const forbidden = [prompt, markerSecret, fixtureRoot, workspaceRoot];
  for (const value of forbidden) {
    assert.equal(metadata.includes(value), false);
    assert.equal(JSON.stringify(firstHistory).includes(value), false);
    assert.equal(JSON.stringify(firstConnection.frames).includes(value), false);
  }

  const secondConnection = new SmokeConnection();
  await chatRunLifecycleService.start({ sessionId: 'diagnostics-smoke', command: 'independent generation', connection: secondConnection });
  const history = await waitFor(() => {
    const rows = sessionRunStateDb.listRecentHistory(10, 'diagnostics-smoke');
    return rows.length === 2 ? rows : null;
  }, 'second independent history row');
  assert.deepEqual(history.map((row) => row.generation), [2, 1]);
  assert.equal(history[1].diagnostic.relativePath, firstHistory.diagnostic.relativePath);
  await waitFor(async () => !(await readdir(diagnosticRoot)).includes('stale-artifact'), 'root-confined retention cleanup');
  const retained = await readdir(diagnosticRoot);
  assert.equal(retained.length, 2);
  for (const entry of retained) assert.equal((await stat(path.join(diagnosticRoot, entry))).isDirectory(), true);
  assert.equal((await stat(firstArtifact)).isDirectory(), true);
  for (const value of [prompt, markerSecret, fixtureRoot]) {
    assert.equal(JSON.stringify(secondConnection.frames).includes(value), false);
  }

  chatRunRegistry.clearAll();
  closeConnection();
  console.log('OpenCode crash diagnostics smoke passed using temporary fixtures only.');
} finally {
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
  await rm(fixtureRoot, { recursive: true, force: true });
}
