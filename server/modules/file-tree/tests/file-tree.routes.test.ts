import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type RequestHandler } from 'express';

import { createFileTreeRouter } from '@/modules/file-tree/file-tree.routes.js';
import type { FileTreeServices } from '@/shared/types.js';

function createFakeServices(overrides: Partial<FileTreeServices> = {}): FileTreeServices {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree service call');
  };

  return {
    browseWorkspace: unexpectedOperation,
    createWorkspaceFolder: unexpectedOperation,
    readTextFile: unexpectedOperation,
    openFile: unexpectedOperation,
    saveTextFile: unexpectedOperation,
    listProjectFiles: unexpectedOperation,
    listProjectFilePage: unexpectedOperation,
    createEntry: unexpectedOperation,
    renameEntry: unexpectedOperation,
    deleteEntry: unexpectedOperation,
    batchMutateEntries: unexpectedOperation,
    storeUploadedFiles: unexpectedOperation,
    ...overrides,
  };
}

const passUploadRequest: RequestHandler = (_request, _response, next) => next();

async function withFileTreeServer(
  services: FileTreeServices,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/file-tree', createFileTreeRouter(
    services,
    passUploadRequest,
    { maximumFileSizeMegabytes: 200, maximumFileCount: 20 },
    { error: () => undefined },
  ));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('project files route uses the File Tree API namespace and forwards the project id', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: false }]]);
});

test('project files route requests gitignore filtering when explicitly enabled', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files?respectGitignore=true`,
    );

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: true }]]);
});

test('project files route parses, clamps, and forwards listing controls', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files?targetPath=src%2Fcomponents&depth=999&includeMetadata=false&respectGitignore=true`,
    );

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [[
    'project-1',
    {
      respectGitignore: true,
      targetPath: 'src/components',
      depth: 10,
      includeMetadata: false,
    },
  ]]);
});

test('project files route rejects invalid depth before invoking the service', async () => {
  let listCalled = false;
  const services = createFakeServices({
    listProjectFiles: async () => {
      listCalled = true;
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files?depth=-1`,
    );
    const payload = await response.json() as { error: string };

    assert.equal(response.status, 400);
    assert.equal(payload.error, 'depth must be a non-negative integer');
  });

  assert.equal(listCalled, false);
});

test('project file page route parses defaults, clamps limits, and delegates separately', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFilePage']>[] = [];
  const services = createFakeServices({
    listProjectFilePage: async (...input) => {
      inputs.push(input);
      return { items: [], hasMore: false, nextOffset: null, total: 0 };
    },
  });
  await withFileTreeServer(services, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/page`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/page?targetPath=src&offset=4&limit=999&includeMetadata=false&respectGitignore=true`)).status, 200);
  });
  assert.deepEqual(inputs, [
    ['project-1', { respectGitignore: false, offset: 0, limit: 150 }],
    ['project-1', { respectGitignore: true, offset: 4, limit: 250, targetPath: 'src', includeMetadata: false }],
  ]);
});

test('project file page route rejects invalid offsets before delegation', async () => {
  let called = false;
  const services = createFakeServices({ listProjectFilePage: async () => {
    called = true;
    return { items: [], hasMore: false, nextOffset: null, total: 0 };
  } });
  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/page?offset=-1`);
    assert.equal(response.status, 400);
  });
  assert.equal(called, false);
});

test('create route parses the transport payload before invoking the service', async () => {
  const inputs: Parameters<FileTreeServices['createEntry']>[0][] = [];
  const services = createFakeServices({
    createEntry: async (input) => {
      inputs.push(input);
      return {
        success: true,
        path: '/workspace/project/src/example.ts',
        name: input.name,
        type: input.type,
        message: 'File created successfully',
      };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: '/workspace/project/src',
        type: 'file',
        name: 'example.ts',
      }),
    });

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [{
    projectId: 'project-1',
    parentPath: '/workspace/project/src',
    type: 'file',
    name: 'example.ts',
  }]);
});

test('create route rejects invalid entry types without calling the service', async () => {
  let createCalled = false;
  const services = createFakeServices({
    createEntry: async () => {
      createCalled = true;
      throw new Error('createEntry should not run for invalid input');
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'link', name: 'example' }),
    });
    const payload = await response.json() as { error: string };

    assert.equal(response.status, 400);
    assert.equal(payload.error, 'Type must be "file" or "directory"');
  });

  assert.equal(createCalled, false);
});

test('batch route validates and delegates one project-scoped operation', async () => {
  const inputs: Parameters<FileTreeServices['batchMutateEntries']>[0][] = [];
  const services = createFakeServices({ batchMutateEntries: async (input) => {
    inputs.push(input);
    return { success: true, operation: input.operation, affectedPaths: input.sourcePaths, destinationPaths: [], message: 'done' };
  } });
  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/batch`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'move', sourcePaths: ['src/a.ts', 'docs'], destinationPath: 'archive' }),
    });
    assert.equal(response.status, 200);
  });
  assert.deepEqual(inputs, [{ projectId: 'project-1', operation: 'move', sourcePaths: ['src/a.ts', 'docs'], destinationPath: 'archive' }]);
});

test('batch route delegates an empty destinationPath as the project root', async () => {
  const inputs: Parameters<FileTreeServices['batchMutateEntries']>[0][] = [];
  const services = createFakeServices({ batchMutateEntries: async (input) => {
    inputs.push(input);
    return { success: true, operation: input.operation, affectedPaths: input.sourcePaths, destinationPaths: [], message: 'done' };
  } });
  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/batch`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'copy', sourcePaths: ['src/a.ts'], destinationPath: '' }),
    });
    assert.equal(response.status, 200);
  });
  assert.deepEqual(inputs, [{
    projectId: 'project-1', operation: 'copy', sourcePaths: ['src/a.ts'], destinationPath: '',
  }]);
});

test('batch route rejects malformed operation, sources, and destination without delegation', async () => {
  let called = false;
  const services = createFakeServices({ batchMutateEntries: async () => { called = true; throw new Error('unexpected'); } });
  await withFileTreeServer(services, async (baseUrl) => {
    for (const body of [
      { operation: 'rename', sourcePaths: ['a'] },
      { operation: 'delete', sourcePaths: [] },
      { operation: 'copy', sourcePaths: ['a'] },
      { operation: 'move', sources: ['a'], destination: 'target' },
      { operation: 'delete', sourcePaths: ['a'], destinationPath: 'target' },
    ]) {
      const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/batch`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
    }
  });
  assert.equal(called, false);
});
