import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { defaultResourceBudget, listValidation, runValidation, validationJobs } from './test-all.mjs';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); killedWith = null;
  kill(signal) { this.killedWith = signal; queueMicrotask(() => this.emit('exit', null, signal)); return true; }
}
const signals = () => new EventEmitter(); const tick = () => new Promise(setImmediate);
const oneJob = [{ id: 'fake', label: 'fake job', command: 'x', args: [], weight: 1, priority: 1 }];
function outputChild({ stdout = '', stderr = '', code = 0 } = {}) { const child = new FakeChild(); queueMicrotask(() => { if (stdout) child.stdout.emit('data', stdout); if (stderr) child.stderr.emit('data', stderr); child.stdout.emit('end'); child.stderr.emit('end'); child.emit('exit', code, null); }); return child; }

test('priority scheduling starts critical heavy work early and respects weighted limit', async () => {
  const starts = []; const children = new Map(); let running = 0; let maximum = 0;
  const jobs = [
    { id: 'cheap', label: 'cheap', command: 'x', args: [], phase: 'source', weight: 1, priority: 1 },
    { id: 'long-a', label: 'long-a', command: 'x', args: [], phase: 'source', weight: 2, priority: 100 },
    { id: 'long-b', label: 'long-b', command: 'x', args: [], phase: 'source', weight: 2, priority: 90 },
    { id: 'build', label: 'build', command: 'x', args: [], phase: 'source', weight: 1, priority: 80 },
  ];
  const promise = runValidation({ jobs, budget: 5, signalSource: signals(), stdout() {}, stderr() {}, spawnCheck(job) { starts.push(job.id); running += job.weight; maximum = Math.max(maximum, running); const child = new FakeChild(); child.once('exit', () => { running -= job.weight; }); children.set(job.id, child); return child; } });
  await tick(); assert.deepEqual(starts, ['long-a', 'long-b', 'build']); assert.equal(maximum, 5);
  children.get('build').emit('exit', 0, null); await tick(); assert.deepEqual(starts, ['long-a', 'long-b', 'build', 'cheap']);
  for (const id of ['cheap', 'long-a', 'long-b']) children.get(id).emit('exit', 0, null);
  assert.equal(await promise, 0);
});

test('jobs wait only for their explicit dependencies', async () => {
  const starts = []; const children = new Map();
  const jobs = [{ id: 'source', label: 'source', command: 'x', args: [], weight: 1, priority: 3 }, { id: 'build', label: 'build', command: 'x', args: [], weight: 1, priority: 2 }, { id: 'runtime', label: 'runtime', command: 'x', args: [], weight: 1, priority: 1, dependencies: ['build'] }];
  const promise = runValidation({ jobs, budget: 3, signalSource: signals(), stdout() {}, stderr() {}, spawnCheck(job) { starts.push(job.id); const child = new FakeChild(); children.set(job.id, child); return child; } });
  await tick(); assert.deepEqual(starts, ['source', 'build']); children.get('build').emit('exit', 0, null); await tick(); assert.deepEqual(starts, ['source', 'build', 'runtime']); children.get('runtime').emit('exit', 0, null); children.get('source').emit('exit', 0, null); assert.equal(await promise, 0);
});

test('failure cancels siblings, prevents runtime, and returns child status', async () => {
  const starts = []; const children = new Map(); const jobs = [{ id: 'a', label: 'a', command: 'x', args: [], weight: 1 }, { id: 'b', label: 'b', command: 'x', args: [], weight: 1 }, { id: 'runtime', label: 'runtime', command: 'x', args: [], phase: 'runtime', weight: 1 }];
  const promise = runValidation({ jobs, budget: 2, signalSource: signals(), stdout() {}, stderr() {}, spawnCheck(job) { starts.push(job.id); const child = new FakeChild(); children.set(job.id, child); return child; } });
  await tick(); children.get('a').emit('exit', 7, null); assert.equal(await promise, 7); assert.equal(children.get('b').killedWith, 'SIGTERM'); assert.deepEqual(starts, ['a', 'b']);
});

for (const signal of ['SIGINT', 'SIGTERM']) test(`${signal} is forwarded and fails the run`, async () => { const source = signals(); let child; const promise = runValidation({ jobs: oneJob, budget: 1, signalSource: source, stdout() {}, stderr() {}, spawnCheck() { child = new FakeChild(); return child; } }); await tick(); source.emit(signal); assert.equal(await promise, 1); assert.equal(child.killedWith, signal); });

test('default graph contains every optimized validation exactly once', () => {
  const ids = validationJobs.map((job) => job.id); assert.equal(new Set(ids).size, 10);
  assert.ok(validationJobs.every((job) => job.command !== 'npm' && job.command !== 'npm.cmd'));
  assert.deepEqual(ids, ['server-build', 'client-build', 'frontend-contract-tests', 'playwright', 'frontend-typecheck', 'lint', 'crash-diagnostics', 'realtime-hydration', 'backend-tests', 'session-recovery']);
  assert.equal(validationJobs.some((job) => job.id === 'backend-typecheck'), false);
  const combined = validationJobs.find((job) => job.id === 'frontend-contract-tests');
  assert.ok(combined.args.includes('--test-isolation=none')); assert.ok(combined.args.includes('shared/**/*.test.ts')); assert.ok(combined.args.includes('src/**/*.test.tsx'));
  const backend = validationJobs.find((job) => job.id === 'backend-tests'); assert.deepEqual(backend.dependencies, ['server-build']); assert.deepEqual(backend.args, ['scripts/validation/run-backend-tests.mjs']);
  assert.equal(backend.priority, 99); assert.equal(validationJobs.find((job) => job.id === 'client-build').weight, 1);
  assert.deepEqual(validationJobs.find((job) => job.id === 'session-recovery').dependencies, ['server-build', 'client-build']);
  assert.deepEqual(validationJobs.find((job) => job.id === 'playwright').dependencies, undefined);
  assert.deepEqual(validationJobs.find((job) => job.id === 'crash-diagnostics').dependencies, undefined);
});

test('budget override and list explain explicit dependency scheduling', () => { assert.equal(defaultResourceBudget({ CLOUDCLI_TEST_BUDGET: '7' }), 7); assert.equal(defaultResourceBudget({}), 6); let output = ''; listValidation(validationJobs, (text) => { output += text; }, 6); assert.match(output, /hard limit 2 simultaneous heavy/); assert.match(output, /higher priority starts first/); assert.match(output, /only for explicit dependencies/); assert.match(output, /server-build \[weight 2; priority 100; depends: none\]/); assert.match(output, /backend-tests \[weight 2; priority 99; depends: server-build\]/); });

test('quiet success suppresses child noise and reports timed parsed totals', async () => { let out = ''; let err = ''; const code = await runValidation({ jobs: oneJob, budget: 1, signalSource: signals(), stdout(text) { out += text; }, stderr(text) { err += text; }, spawnCheck() { return outputChild({ stdout: '> package banner\nroutine info\n# tests 42\n# pass 41\n# skipped 1\n' }); } }); assert.equal(code, 0); assert.doesNotMatch(out, /package banner|routine info/); assert.match(out, /PASS \d+\.\ds \(42 tests, 41 passed, 1 skipped\)/); assert.match(out, /All deterministic validation checks passed in \d+\.\ds\./); assert.equal(err, ''); });

test('verbose mode streams complete labelled stdout and stderr', async () => { let out = ''; let err = ''; const code = await runValidation({ jobs: oneJob, budget: 1, verbose: true, signalSource: signals(), stdout(text) { out += text; }, stderr(text) { err += text; }, spawnCheck() { return outputChild({ stdout: 'first\npartial', stderr: 'debug\n' }); } }); assert.equal(code, 0); assert.match(out, /\[fake job\] first/); assert.match(out, /\[fake job\] partial/); assert.match(err, /\[fake job\] debug/); });

test('quiet failure prints bounded captured tail with truncation notice', async () => { let err = ''; const code = await runValidation({ jobs: oneJob, budget: 1, captureBytes: 80, signalSource: signals(), stdout() {}, stderr(text) { err += text; }, spawnCheck() { return outputChild({ stdout: `${'old noise\n'.repeat(30)}ACTIONABLE FINAL ERROR\n`, stderr: 'last stderr detail\n', code: 9 }); } }); assert.equal(code, 9); assert.match(err, /bytes truncated/); assert.match(err, /ACTIONABLE FINAL ERROR/); assert.match(err, /last stderr detail/); assert.doesNotMatch(err, /old noise\nold noise\nold noise\nold noise\nold noise/); assert.match(err, /--verbose/); });
