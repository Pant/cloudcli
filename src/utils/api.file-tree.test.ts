import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFileTreePageUrl, buildFileTreeQuery, buildFileTreeUrl } from './api';

test('builds encoded root, nested, depth, metadata, and ignore options', () => {
  const query = buildFileTreeQuery({
    targetPath: '/workspace/my project/src?x=1',
    depth: 0,
    includeMetadata: false,
    respectGitignore: true,
  });

  assert.deepEqual([...new URLSearchParams(query)], [
    ['targetPath', '/workspace/my project/src?x=1'],
    ['depth', '0'],
    ['includeMetadata', 'false'],
    ['respectGitignore', 'true'],
  ]);
  assert.match(query, /targetPath=%2Fworkspace%2Fmy\+project%2Fsrc%3Fx%3D1/);
});

test('builds a dedicated project-safe explorer page URL', () => {
  assert.equal(
    buildFileTreePageUrl('project/with spaces', {
      targetPath: 'src/nested folder', offset: 150, limit: 75, includeMetadata: false,
    }),
    '/api/file-tree/projects/project%2Fwith%20spaces/files/page?targetPath=src%2Fnested+folder&includeMetadata=false&offset=150&limit=75',
  );
});

test('root requests omit the target path while supporting full-depth metadata', () => {
  assert.deepEqual([...new URLSearchParams(buildFileTreeQuery({
    depth: 10,
    metadata: true,
  }))], [
    ['depth', '10'],
    ['includeMetadata', 'true'],
  ]);
});

test('builds a project-id-safe URL without hand-built query strings', () => {
  const url = buildFileTreeUrl('project/with spaces', {
    path: 'src/nested folder',
    depth: 2,
    includeMetadata: true,
  });

  assert.equal(
    url,
    '/api/file-tree/projects/project%2Fwith%20spaces/files?targetPath=src%2Fnested+folder&depth=2&includeMetadata=true',
  );
});
