import assert from 'node:assert/strict';
import test from 'node:test';

import type { FileTreeNode } from '../types/types';

import {
  createFileTreeGeneration,
  createRecentProjectFileTreeCache,
  collectFileTreeZipEntries,
  extractFileTreeSubtree,
  findLoadedDirectoryPaths,
  formatFileSize,
  isFileTreeGenerationCurrent,
  isStaleFileTreeGeneration,
  markDirectoryLoaded,
  nextFileTreeGeneration,
  replaceDirectoryChildren,
  replaceFileTreeSubtree,
  replaceRootChildrenPreservingLoadedBranches,
} from './fileTreeUtils';
import {
  createExplorerDirectoryRequestPlan,
  advanceExplorerRequestGeneration,
  createExplorerRequestGeneration,
  FileTreeInFlightRequests,
  FileTreeSnapshotRequest,
  getCachedFileTreeInitialState,
  planLoadedBranchRefresh,
} from './fileTreeRequestUtils';

const file = (path: string): FileTreeNode => ({
  name: path.split('/').pop() || path,
  path,
  type: 'file',
});

const directory = (path: string, children?: FileTreeNode[]): FileTreeNode => ({
  name: path.split('/').pop() || path,
  path,
  type: 'directory',
  ...(children === undefined ? {} : { children }),
});

test('replaces root and nested directory children immutably', () => {
  const rootFile = file('/project/readme.md');
  const sourceFile = file('/project/src/old.ts');
  const source = directory('/project/src', [sourceFile]);
  const docs = directory('/project/docs');
  const tree = [rootFile, source, docs];
  const replacement = [file('/project/src/new.ts')];

  const merged = replaceDirectoryChildren(tree, '/project/src', replacement);

  assert.notEqual(merged, tree);
  assert.equal(merged[0], rootFile);
  assert.equal(merged[2], docs);
  assert.notEqual(merged[1], source);
  assert.deepEqual(merged[1]?.children, replacement);
  assert.equal(source.children?.[0], sourceFile);

  const rootReplacement = [directory('/project')];
  assert.equal(replaceDirectoryChildren(tree, undefined, rootReplacement), rootReplacement);
});

test('loaded empty directories retain [] instead of becoming unloaded', () => {
  const unloaded = directory('/project/empty');
  const tree = [unloaded];

  assert.equal(tree[0]?.children, undefined);
  const loaded = markDirectoryLoaded(tree, '/project/empty');

  assert.deepEqual(loaded[0]?.children, []);
  assert.notEqual(loaded[0], unloaded);
  assert.deepEqual(findLoadedDirectoryPaths(loaded), ['/project/empty']);
  assert.deepEqual(
    findLoadedDirectoryPaths([directory('/project/other', [file('/project/other/a')])]),
    ['/project/other'],
  );
});

test('missing directory targets are no-ops and preserve the original tree', () => {
  const tree = [directory('/project/src', [file('/project/src/a.ts')])];
  const result = replaceDirectoryChildren(tree, '/project/missing', []);

  assert.equal(result, tree);
  assert.equal(replaceFileTreeSubtree(tree, '/project/missing', file('/project/new')), tree);
});

test('extracts and replaces a nested subtree while preserving unrelated identity', () => {
  const src = directory('/project/src', [file('/project/src/a.ts')]);
  const docs = directory('/project/docs', [file('/project/docs/readme.md')]);
  const tree = [src, docs];
  const extracted = extractFileTreeSubtree(tree, '/project/src');
  const replacement = directory('/project/src', [file('/project/src/b.ts')]);
  const replaced = replaceFileTreeSubtree(tree, '/project/src', replacement);

  assert.equal(extracted, src);
  assert.equal(replaced[1], docs);
  assert.equal(replaced[0], replacement);
  assert.equal(tree[0], src);
});

test('generation guards accept only the current project generation', () => {
  const initial = createFileTreeGeneration('project-a');
  const refreshed = nextFileTreeGeneration(initial);
  const switched = nextFileTreeGeneration(refreshed, 'project-b');

  assert.equal(isFileTreeGenerationCurrent(initial, initial), true);
  assert.equal(isFileTreeGenerationCurrent(refreshed, initial), false);
  assert.equal(isStaleFileTreeGeneration(refreshed, initial), true);
  assert.equal(isFileTreeGenerationCurrent(switched, refreshed), false);
  assert.equal(isStaleFileTreeGeneration(switched, switched), false);
});

test('project changes advance the request generation and invalidate old requests', () => {
  const initial = createExplorerRequestGeneration('project-a');
  const refreshed = advanceExplorerRequestGeneration(initial, 'project-a');
  const switched = advanceExplorerRequestGeneration(refreshed, 'project-b');

  assert.deepEqual(refreshed, { projectId: 'project-a', generation: 1 });
  assert.deepEqual(switched, { projectId: 'project-b', generation: 0 });
});

test('recent-project cache is project-keyed, bounded, and least-recently-used', () => {
  const cache = createRecentProjectFileTreeCache<string>(2);
  cache.set('project-a', 'a');
  cache.set('project-b', 'b');
  assert.equal(cache.get('project-a'), 'a');
  cache.set('project-c', 'c');

  assert.equal(cache.has('project-a'), true);
  assert.equal(cache.has('project-b'), false);
  assert.equal(cache.get('project-c'), 'c');
  assert.deepEqual(cache.keys(), ['project-a', 'project-c']);
  assert.equal(cache.size, 2);
});

test('cached initial state hydrates synchronously while cache absence stays loading', () => {
  const cached = [directory('/project/src')];
  const readCache = (projectId: string) => projectId === 'project-a' ? cached : undefined;

  assert.deepEqual(getCachedFileTreeInitialState('project-a', readCache), {
    files: cached,
    hasCachedTree: true,
  });
  assert.deepEqual(getCachedFileTreeInitialState('project-b', readCache), {
    files: [],
    hasCachedTree: false,
  });
  assert.deepEqual(getCachedFileTreeInitialState(undefined, readCache), {
    files: [],
    hasCachedTree: false,
  });
});

test('explorer requests are shallow and metadata-enabled for root and loaded branches', () => {
  assert.deepEqual(createExplorerDirectoryRequestPlan(), {
    depth: 0,
    includeMetadata: true,
  });
  assert.deepEqual(createExplorerDirectoryRequestPlan('/project/src'), {
    targetPath: '/project/src',
    depth: 0,
    includeMetadata: true,
  });

  const tree = [directory('/project/src', [directory('/project/src/lib', [])]), directory('/project/empty', [])];
  assert.deepEqual(planLoadedBranchRefresh(tree), [
    { depth: 0, includeMetadata: true },
    { targetPath: '/project/src', depth: 0, includeMetadata: true },
    { targetPath: '/project/src/lib', depth: 0, includeMetadata: true },
    { targetPath: '/project/empty', depth: 0, includeMetadata: true },
  ]);
});

test('root revalidation takes fresh metadata while preserving loaded children', () => {
  const loaded = { ...directory('/project/src', [file('/project/src/main.ts')]), modified: 'old', permissionsRwx: 'old' };
  const freshDirectory = { ...directory('/project/src'), modified: 'fresh', permissionsRwx: 'rwxr-xr-x' };
  const replacement = [freshDirectory, { ...file('/project/readme.md'), size: 128 }];
  const merged = replaceRootChildrenPreservingLoadedBranches([loaded], replacement);

  assert.notEqual(merged[0], replacement[0]);
  assert.deepEqual(merged[0]?.children, loaded.children);
  assert.equal(merged[0]?.modified, 'fresh');
  assert.equal(merged[0]?.permissionsRwx, 'rwxr-xr-x');
  assert.equal(merged[1], replacement[1]);
});

test('nested refresh replaces placeholder metadata with real metadata', () => {
  const tree = [directory('/project/src', [{ ...file('/project/src/main.ts'), size: 0 }])];
  const freshFile = {
    ...file('/project/src/main.ts'),
    size: 4096,
    modified: '2026-08-07T12:00:00.000Z',
    permissionsRwx: 'rw-r--r--',
  };

  const refreshed = replaceDirectoryChildren(tree, '/project/src', [freshFile]);

  assert.equal(refreshed[0]?.children?.[0], freshFile);
  assert.deepEqual(refreshed[0]?.children?.[0], freshFile);
});

test('file size formatting distinguishes known empty files from unavailable metadata', () => {
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(4096), '4 KB');
  assert.equal(formatFileSize(undefined), '-');
});

test('in-flight directory requests deduplicate and clear after empty completion', async () => {
  const requests = new FileTreeInFlightRequests<FileTreeNode[]>();
  const generation = createExplorerRequestGeneration('project-a');
  let calls = 0;
  let resolveRequest: ((value: FileTreeNode[]) => void) | undefined;
  const createRequest = () => {
    calls += 1;
    return new Promise<FileTreeNode[]>((resolve) => {
      resolveRequest = resolve;
    });
  };

  const first = requests.getOrCreate('/project/empty', generation, createRequest);
  const second = requests.getOrCreate('/project/empty', generation, createRequest);
  assert.equal(first, second);
  assert.equal(calls, 1);

  resolveRequest?.([]);
  await first;
  const afterCompletion = requests.getOrCreate('/project/empty', generation, async () => {
    calls += 1;
    return [];
  });
  await afterCompletion;
  assert.equal(calls, 2);
});

test('complete-tree snapshots deduplicate, reuse query edits, and invalidate by generation', async () => {
  const snapshots = new FileTreeSnapshotRequest<FileTreeNode[]>();
  const generation = createExplorerRequestGeneration('project-a');
  const refreshed = advanceExplorerRequestGeneration(generation, 'project-a');
  let calls = 0;
  let resolveRequest: ((value: FileTreeNode[]) => void) | undefined;
  const tree = [file('/project/src/main.ts')];
  const request = () => {
    calls += 1;
    return new Promise<FileTreeNode[]>((resolve) => {
      resolveRequest = resolve;
    });
  };

  const first = snapshots.getOrCreate(generation, request);
  const second = snapshots.getOrCreate(generation, request);
  assert.equal(first, second);
  assert.equal(calls, 1);

  resolveRequest?.(tree);
  assert.deepEqual(await first, tree);
  assert.equal(snapshots.getSnapshot(generation), tree);
  assert.equal(await snapshots.getOrCreate(generation, request), tree);
  assert.equal(calls, 1);

  snapshots.invalidate();
  const afterInvalidation = snapshots.getOrCreate(generation, async () => {
    calls += 1;
    return tree;
  });
  assert.equal(await afterInvalidation, tree);
  assert.equal(calls, 2);

  const afterRefresh = snapshots.getOrCreate(refreshed, async () => {
    calls += 1;
    return tree;
  });
  assert.equal(await afterRefresh, tree);
  assert.equal(calls, 3);
});

test('ZIP manifest collection includes files from every complete descendant branch', () => {
  const entries = collectFileTreeZipEntries([
    directory('/project/src', [
      file('/project/src/main.ts'),
      directory('/project/src/lib', [file('/project/src/lib/util.ts')]),
    ]),
  ]);

  assert.deepEqual(entries.map((entry) => ({ path: entry.node.path, archivePath: entry.archivePath })), [
    { path: '/project/src/main.ts', archivePath: 'src/main.ts' },
    { path: '/project/src/lib/util.ts', archivePath: 'src/lib/util.ts' },
  ]);
});
