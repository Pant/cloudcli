import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = (name) => path.join('node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
const node = process.execPath;
const tsxEnv = { TSX_TSCONFIG_PATH: 'server/tsconfig.json' };
const DEFAULT_CAPTURE_BYTES = 256 * 1024;

export const validationJobs = [
  { id: 'server-build', label: 'server build', command: bin('concurrently'), args: [`${node} scripts/validation/prepare-server-build.mjs && ${bin('tsc')} -p server/tsconfig.json && ${bin('tsc-alias')} -p server/tsconfig.json`], env: { NODE_ENV: 'production' }, weight: 2, priority: 100 },
  { id: 'client-build', label: 'client build', command: bin('concurrently'), args: [`${bin('vite')} build --mode production && ${node} scripts/validation/client-codemirror-chunks.mjs && ${node} scripts/validation/client-bundle-budget.mjs`], env: { NODE_ENV: 'production' }, weight: 1, priority: 95 },
  { id: 'frontend-tests', label: 'frontend tests', command: node, args: ['--import', 'tsx', '--test', 'src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/*.test.js'], weight: 2, priority: 90 },
  { id: 'contract-tests', label: 'shared contract tests', command: node, args: ['--import', 'tsx', '--test', 'shared/**/*.test.ts'], weight: 1, priority: 89 },
  { id: 'pwa-source', label: 'PWA source validators', command: node, args: ['--test', 'scripts/validation/service-worker-notifications.test.mjs', 'scripts/validation/service-worker-lifecycle.test.mjs', 'scripts/validation/pwa-install-metadata.test.mjs', 'scripts/validation/font-resources.test.mjs'], weight: 1, priority: 88 },
  { id: 'playwright', label: 'production browser stability matrix', command: bin('playwright'), args: ['test', '--project=stability', '--project=production-pwa', '--project=production-performance'], weight: 2, priority: 85, dependencies: ['client-build'] },
  { id: 'frontend-typecheck', label: 'frontend typecheck', command: bin('tsc'), args: ['--noEmit', '-p', 'tsconfig.json'], weight: 1, priority: 70 },
  { id: 'lint', label: 'full lint', command: bin('eslint'), args: ['--max-warnings', '0', '--cache', '--cache-strategy', 'content', '--cache-location', '.eslintcache', 'src/', 'server/'], weight: 1, priority: 60 },
  { id: 'crash-diagnostics', label: 'OpenCode crash diagnostics smoke', command: node, args: ['--import', 'tsx', 'scripts/validation/opencode-crash-diagnostics-smoke.mjs'], env: tsxEnv, weight: 1, priority: 50 },
  { id: 'realtime-hydration', label: 'realtime hydration smoke', command: node, args: ['--import', 'tsx', 'scripts/validation/realtime-session-hydration-smoke.mjs'], env: tsxEnv, weight: 1, priority: 40 },
  { id: 'backend-tests', label: 'backend tests', command: node, args: ['--import', 'tsx', '--test', 'server/**/*.test.ts', 'server/**/*.test.js'], env: tsxEnv, weight: 2, priority: 99, dependencies: ['server-build'] },
  { id: 'pwa-assets', label: 'PWA asset validation', command: node, args: ['scripts/validation/pwa-assets.mjs'], weight: 1, priority: 45, dependencies: ['client-build'] },
  { id: 'pwa-built-output', label: 'PWA built output validation', command: node, args: ['--test', 'scripts/validation/pwa-built-output.test.mjs'], weight: 1, priority: 44, dependencies: ['client-build'] },
  { id: 'session-recovery', label: 'OpenCode session recovery smoke', command: node, args: ['scripts/validation/opencode-session-recovery-smoke.mjs'], weight: 1, priority: 20, dependencies: ['server-build', 'client-build'] },
];

export function defaultResourceBudget(environment = process.env) {
  const override = Number.parseInt(environment.CLOUDCLI_TEST_BUDGET ?? '', 10);
  if (Number.isInteger(override) && override > 0) return override;
  return Math.min(6, Math.max(3, os.availableParallelism?.() ?? os.cpus().length));
}

export function spawnDirect(job) {
  return spawn(job.command, job.args, { env: { ...process.env, ...job.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

class TailCapture {
  constructor(limit) { this.limit = limit; this.text = ''; this.dropped = 0; }
  append(chunk) {
    this.text += String(chunk);
    if (Buffer.byteLength(this.text) <= this.limit) return;
    const buffer = Buffer.from(this.text);
    const excess = buffer.length - this.limit;
    this.dropped += excess;
    this.text = buffer.subarray(excess).toString('utf8').replace(/^\uFFFD/, '');
  }
  formatted() { return `${this.dropped ? `[... ${this.dropped} bytes truncated; showing captured tail ...]\n` : ''}${this.text}`; }
}

function streamOutput(stream, capture, label, write, verbose) {
  let pending = '';
  stream?.setEncoding?.('utf8');
  stream?.on('data', (chunk) => {
    capture.append(chunk);
    if (!verbose) return;
    pending += String(chunk);
    const lines = pending.split(/\r?\n/); pending = lines.pop() ?? '';
    for (const line of lines) write(`[${label}] ${line}\n`);
  });
  stream?.on('end', () => { if (verbose && pending) write(`[${label}] ${pending}\n`); });
}

const summaryPatterns = [
  [/^(?:#|ℹ)?\s*tests\s+(\d+)$/mi, 'tests'], [/^(?:#|ℹ)?\s*pass\s+(\d+)$/mi, 'passed'],
  [/^(?:#|ℹ)?\s*skipped\s+(\d+)$/mi, 'skipped'], [/(\d+) passed\b/i, 'passed'], [/(\d+) warnings?\b/i, 'warnings'],
];
function outputSummary(text) {
  const totals = [];
  for (const [pattern, label] of summaryPatterns) { const match = text.match(pattern); if (match) totals.push(`${match[1]} ${label}`); }
  return [...new Set(totals)].join(', ');
}

function normalizedJobs(jobs) {
  return jobs.map((job, index) => ({ weight: job.cost ?? 1, priority: jobs.length - index, ...job }));
}

export async function runValidation({
  jobs = validationJobs, budget = defaultResourceBudget(), spawnCheck = spawnDirect,
  stdout = (text) => process.stdout.write(text), stderr = (text) => process.stderr.write(text), signalSource = process,
  verbose = process.env.CLOUDCLI_TEST_VERBOSE === '1', captureBytes = DEFAULT_CAPTURE_BYTES,
} = {}) {
  const validationStartedAt = Date.now();
  const ordered = normalizedJobs(jobs).sort((a, b) => b.priority - a.priority);
  const active = new Map(); const completed = new Set(); const pending = [...ordered];
  let used = 0; let failure = null; let interrupted = false; let wake;
  const notify = () => { wake?.(); wake = null; };
  const cancel = (signal) => { for (const entry of active.values()) entry.child.kill(signal); notify(); };
  const onSigint = () => { interrupted = true; cancel('SIGINT'); };
  const onSigterm = () => { interrupted = true; cancel('SIGTERM'); };
  signalSource.on?.('SIGINT', onSigint); signalSource.on?.('SIGTERM', onSigterm);
  stdout(`\n== deterministic validation (weighted budget ${budget}; heavy checks weight 2) ==\n`);

  const start = (job) => {
    used += job.weight; const startedAt = Date.now();
    stdout(`[${job.label}] START (weight ${job.weight})\n`);
    let child;
    try { child = spawnCheck(job); } catch (error) { used -= job.weight; failure = { job, error }; cancel('SIGTERM'); return; }
    const out = new TailCapture(captureBytes); const err = new TailCapture(captureBytes);
    active.set(job.id, { child }); streamOutput(child.stdout, out, job.label, stdout, verbose); streamOutput(child.stderr, err, job.label, stderr, verbose);
    let settled = false;
    const finish = (result) => {
      if (settled) return; settled = true; active.delete(job.id); used -= job.weight;
      const elapsed = Date.now() - startedAt;
      if (!result.error && !result.signal && result.code === 0 && !failure && !interrupted) {
        completed.add(job.id); const summary = outputSummary(`${out.text}\n${err.text}`);
        stdout(`[${job.label}] PASS ${(elapsed / 1000).toFixed(1)}s${summary ? ` (${summary})` : ''}\n`);
      } else if (!failure && !interrupted && (result.error || result.signal || result.code !== 0)) {
        failure = { job, ...result, elapsed, out, err }; cancel('SIGTERM');
      }
      notify();
    };
    child.once('error', (error) => finish({ error })); child.once('exit', (code, signal) => finish({ code, signal }));
  };

  try {
    while (!failure && !interrupted && (pending.length || active.size)) {
      let admitted = false;
      for (let index = 0; index < pending.length;) {
        const job = pending[index];
        const depsReady = (job.dependencies ?? []).every((id) => completed.has(id));
        const activeHeavy = [...active.keys()].filter((id) => ordered.find((candidate) => candidate.id === id)?.weight === 2).length;
        const heavyReady = job.weight !== 2 || activeHeavy < 2;
        if (depsReady && heavyReady && job.weight <= budget - used) { pending.splice(index, 1); start(job); admitted = true; }
        else index += 1;
      }
      if (!failure && !interrupted && !admitted && active.size) await new Promise((resolve) => { wake = resolve; });
      else if (!failure && !interrupted && !admitted && pending.length) failure = { job: pending[0], error: new Error('validation graph is blocked by missing/cyclic dependencies or insufficient budget') };
    }
    if (active.size) await Promise.all([...active.values()].map(({ child }) => new Promise((resolve) => child.once('exit', resolve))));
    if (failure) {
      const reason = failure.error?.message ?? (failure.signal ? `signal ${failure.signal}` : `exit ${failure.code}`);
      stderr(`[${failure.job.label}] FAIL (${reason}, ${((failure.elapsed ?? 0) / 1000).toFixed(1)}s)\n`);
      if (failure.out && !verbose) {
        for (const [name, capture] of [['stdout', failure.out], ['stderr', failure.err]]) {
          if (!capture.text && !capture.dropped) continue;
          stderr(`[${failure.job.label}] --- captured ${name} ---\n`);
          for (const line of capture.formatted().replace(/\n$/, '').split(/\r?\n/)) stderr(`[${failure.job.label}] ${line}\n`);
        }
        stderr(`[${failure.job.label}] Rerun npm test -- --verbose for complete live output.\n`);
      }
      return failure.code > 0 ? failure.code : 1;
    }
    if (interrupted || completed.size !== jobs.length) return 1;
    stdout(`\nAll deterministic validation checks passed in ${((Date.now() - validationStartedAt) / 1000).toFixed(1)}s.\n`);
    stdout('Skipped by default (requires live user databases): npm run validate:nested-sessions\n'); return 0;
  } finally { signalSource.off?.('SIGINT', onSigint); signalSource.off?.('SIGTERM', onSigterm); }
}

export function formatCommand(job) { const env = Object.entries(job.env ?? {}).map(([key, value]) => `${key}=${value}`).join(' '); return [env, job.command, ...job.args].filter(Boolean).join(' '); }
export function listValidation(jobs = validationJobs, write = (text) => process.stdout.write(text), budget = defaultResourceBudget()) {
  write(`deterministic validation graph (weighted budget ${budget}; weight 2 = heavy; hard limit 2 simultaneous heavy checks; override CLOUDCLI_TEST_BUDGET)\n`);
  write('policy: higher priority starts first; lightweight checks fill spare capacity; each job waits only for explicit dependencies\n');
  for (const job of normalizedJobs(jobs).sort((a, b) => b.priority - a.priority)) write(`  ${job.id} [weight ${job.weight}; priority ${job.priority}; depends: ${(job.dependencies ?? []).join(', ') || 'none'}]\n    ${formatCommand(job)}\n`);
  write('explicit only: npm run validate:nested-sessions (requires live user databases and an existing build)\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--list') || process.argv.includes('--dry-run')) listValidation();
  else process.exitCode = await runValidation({ verbose: process.argv.includes('--verbose') || process.env.CLOUDCLI_TEST_VERBOSE === '1' });
}
