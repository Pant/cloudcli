import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
  ProviderCgroupSnapshot,
  ProviderDiagnosticReference,
  ProviderRuntimeResult,
} from '@/shared/types.js';

const DEFAULT_STDERR_TAIL_BYTES = 32 * 1024;
const DEFAULT_RETENTION_COUNT = 50;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function diagnosticRoot(): string {
  return process.env.CLOUDCLI_OPENCODE_DIAGNOSTIC_ROOT
    || path.join(process.env.CLOUDCLI_DATA_ROOT || path.join(os.homedir(), '.cloudcli'), 'logs', 'opencode');
}

async function readNumericFile(filePath: string): Promise<number | undefined> {
  try {
    const value = Number((await readFile(filePath, 'utf8')).trim());
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readNumericMap(filePath: string): Promise<Record<string, number> | undefined> {
  try {
    const result: Record<string, number> = {};
    for (const line of (await readFile(filePath, 'utf8')).split('\n')) {
      const [key, rawValue] = line.trim().split(/\s+/, 2);
      const value = Number(rawValue);
      if (key && Number.isSafeInteger(value) && value >= 0) result[key] = value;
    }
    return Object.keys(result).length ? result : undefined;
  } catch {
    return undefined;
  }
}

async function captureCgroupSnapshot(): Promise<ProviderCgroupSnapshot | undefined> {
  if (process.platform !== 'linux') return undefined;
  const root = process.env.CLOUDCLI_CGROUP_V2_ROOT || '/sys/fs/cgroup';
  const [memoryCurrentBytes, memoryPeakBytes, memoryEvents, memoryStat] = await Promise.all([
    readNumericFile(path.join(root, 'memory.current')),
    readNumericFile(path.join(root, 'memory.peak')),
    readNumericMap(path.join(root, 'memory.events')),
    readNumericMap(path.join(root, 'memory.stat')),
  ]);
  if (memoryCurrentBytes === undefined && memoryPeakBytes === undefined && !memoryEvents && !memoryStat) {
    return undefined;
  }
  return {
    scope: 'container-cgroup-v2', capturedAt: Date.now(),
    ...(memoryCurrentBytes === undefined ? {} : { memoryCurrentBytes }),
    ...(memoryPeakBytes === undefined ? {} : { memoryPeakBytes }),
    ...(memoryEvents ? { memoryEvents } : {}), ...(memoryStat ? { memoryStat } : {}),
  };
}

async function prune(root: string, retainedRunId: string): Promise<void> {
  try {
    const count = positiveInteger(process.env.CLOUDCLI_OPENCODE_DIAGNOSTIC_RETENTION_COUNT, DEFAULT_RETENTION_COUNT);
    const entries = await readdir(root, { withFileTypes: true });
    const directories = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => ({
      name: entry.name,
      modifiedAt: (await stat(path.join(root, entry.name))).mtimeMs,
    })));
    directories.sort((left, right) => right.modifiedAt - left.modifiedAt);
    await Promise.all(directories.slice(count).filter(({ name }) => name !== retainedRunId).map(({ name }) =>
      rm(path.join(root, name), { recursive: true, force: true })));
  } catch {
    // Retention is diagnostic hygiene and must never affect a provider run.
  }
}

export type OpenCodeRunDiagnostics = {
  runId: string;
  reference?: ProviderDiagnosticReference;
  startResources?: ProviderCgroupSnapshot;
  appendStdout(data: Buffer): void;
  appendStderr(data: Buffer): void;
  stderrTail(): string;
  finish(input: Omit<ProviderRuntimeResult, 'diagnostic' | 'stderrTail' | 'resources'>): Promise<ProviderRuntimeResult>;
};

/** OpenCode runtime uses this provider-private, fail-open artifact collector per spawn. */
export async function createOpenCodeRunDiagnostics(startedAt: number): Promise<OpenCodeRunDiagnostics> {
  const runId = `${startedAt.toString(36)}-${randomUUID()}`;
  const root = diagnosticRoot();
  const runDirectory = path.join(root, runId);
  const tailLimit = positiveInteger(process.env.CLOUDCLI_OPENCODE_STDERR_TAIL_BYTES, DEFAULT_STDERR_TAIL_BYTES);
  let reference: ProviderDiagnosticReference | undefined;
  let stderr = Buffer.alloc(0);
  const pendingWrites = new Set<Promise<void>>();
  try {
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    reference = { runId, relativePath: runId };
    void prune(root, runId);
  } catch {
    // Artifact creation is best effort.
  }
  const startResources = await captureCgroupSnapshot();
  const append = (fileName: string, data: Buffer) => {
    if (!reference) return;
    const pendingWrite = appendFile(path.join(runDirectory, fileName), data)
      .catch(() => {})
      .finally(() => pendingWrites.delete(pendingWrite));
    pendingWrites.add(pendingWrite);
  };
  return {
    runId, reference, startResources,
    appendStdout(data) { append('stdout.log', data); },
    appendStderr(data) {
      append('stderr.log', data);
      stderr = Buffer.concat([stderr, data]);
      if (stderr.length > tailLimit) stderr = stderr.subarray(stderr.length - tailLimit);
    },
    stderrTail: () => stderr.toString('utf8'),
    async finish(input) {
      await Promise.all(pendingWrites);
      const endResources = await captureCgroupSnapshot();
      const result: ProviderRuntimeResult = {
        ...input,
        ...(reference ? { diagnostic: reference } : {}),
        stderrTail: stderr.toString('utf8'),
        ...((startResources || endResources) ? { resources: {
          ...(startResources ? { start: startResources } : {}),
          ...(endResources ? { end: endResources } : {}),
        } } : {}),
      };
      if (reference) {
        await writeFile(path.join(runDirectory, 'metadata.json'), `${JSON.stringify({
          runId, command: 'opencode run', startedAt: result.startedAt, endedAt: result.endedAt,
          lastOutputAt: result.lastOutputAt, exitCode: result.exitCode, signal: result.signal,
          resources: result.resources,
        }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }).catch(() => {});
      }
      return result;
    },
  };
}
