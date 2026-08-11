import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type {
  FileTreeListOptions,
  FileTreePageOptions,
  FileTreeLogger,
  FileTreeServices,
  FileTreeUploadedFile,
} from '@/shared/types.js';
import {
  AppError,
  FILE_TREE_DEFAULT_PAGE_SIZE,
  FILE_TREE_MAX_DEPTH,
  FILE_TREE_MAX_PAGE_SIZE,
} from '@/shared/utils.js';

type FileTreeUploadLimits = {
  maximumFileSizeMegabytes: number;
  maximumFileCount: number;
};

type UploadedRequest = Request & {
  files?: Express.Multer.File[];
};

function readBody(request: Request): Record<string, unknown> {
  return typeof request.body === 'object' && request.body !== null
    ? request.body as Record<string, unknown>
    : {};
}

function readRequiredString(value: unknown, fieldName: string, message?: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(message ?? `${fieldName} is required`, {
      code: 'INVALID_FILE_TREE_REQUEST',
      statusCode: 400,
    });
  }
  return value;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new AppError(`${fieldName} must be "true" or "false"`, {
    code: 'INVALID_FILE_TREE_REQUEST',
    statusCode: 400,
  });
}

function readFileTreeDepth(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new AppError('depth must be a non-negative integer', {
      code: 'INVALID_FILE_TREE_DEPTH',
      statusCode: 400,
    });
  }

  const parsedDepth = Number(value);
  if (!Number.isSafeInteger(parsedDepth)) {
    throw new AppError('depth must be a safe non-negative integer', {
      code: 'INVALID_FILE_TREE_DEPTH',
      statusCode: 400,
    });
  }
  return Math.min(parsedDepth, FILE_TREE_MAX_DEPTH);
}

function readFileTreeOptions(request: Request): FileTreeListOptions {
  const respectGitignore = readOptionalBoolean(request.query.respectGitignore, 'respectGitignore') ?? false;
  const includeMetadata = readOptionalBoolean(request.query.includeMetadata, 'includeMetadata');
  const targetPath = readOptionalString(request.query.targetPath);
  const depth = readFileTreeDepth(request.query.depth);

  return {
    respectGitignore,
    ...(targetPath !== null ? { targetPath } : {}),
    ...(depth !== undefined ? { depth } : {}),
    ...(includeMetadata !== undefined ? { includeMetadata } : {}),
  };
}

function readPageInteger(value: unknown, fieldName: string, fallback: number, maximum?: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new AppError(`${fieldName} must be a non-negative integer`, {
      code: 'INVALID_FILE_TREE_REQUEST', statusCode: 400,
    });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new AppError(`${fieldName} must be a safe non-negative integer`, {
      code: 'INVALID_FILE_TREE_REQUEST', statusCode: 400,
    });
  }
  return maximum === undefined ? parsed : Math.min(maximum, Math.max(1, parsed));
}

function readFileTreePageOptions(request: Request): FileTreePageOptions {
  const targetPath = readOptionalString(request.query.targetPath);
  const includeMetadata = readOptionalBoolean(request.query.includeMetadata, 'includeMetadata');
  return {
    respectGitignore: readOptionalBoolean(request.query.respectGitignore, 'respectGitignore') ?? false,
    offset: readPageInteger(request.query.offset, 'offset', 0),
    limit: readPageInteger(request.query.limit, 'limit', FILE_TREE_DEFAULT_PAGE_SIZE, FILE_TREE_MAX_PAGE_SIZE),
    ...(targetPath !== null ? { targetPath } : {}),
    ...(includeMetadata !== undefined ? { includeMetadata } : {}),
  };
}

function readProjectId(request: Request): string {
  return readRequiredString(request.params.projectId, 'projectId');
}

function readEntryType(value: unknown): 'file' | 'directory' {
  if (value !== 'file' && value !== 'directory') {
    throw new AppError('Type must be "file" or "directory"', {
      code: 'INVALID_FILE_TREE_ENTRY_TYPE',
      statusCode: 400,
    });
  }
  return value;
}

function readRelativePaths(value: unknown): string[] {
  if (typeof value !== 'string' || !value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function readRequestedFileCount(value: unknown, fallbackCount: number): number {
  const parsedCount = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsedCount) && parsedCount > 0 ? parsedCount : fallbackCount;
}

function normalizeUploadedFiles(request: UploadedRequest): FileTreeUploadedFile[] {
  return Array.isArray(request.files)
    ? request.files.map((file) => ({
        originalName: file.originalname,
        temporaryPath: file.path,
        size: file.size,
        mimeType: file.mimetype,
      }))
    : [];
}

function createRouteHandler(
  operation: (request: Request, response: Response) => void | Promise<void>,
  logger: FileTreeLogger,
): RequestHandler {
  return async (request, response) => {
    try {
      await operation(request, response);
    } catch (error) {
      if (error instanceof AppError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      logger.error('File Tree API error', error);
      response.status(500).json({ error: message });
    }
  };
}

/**
 * Builds the File Tree HTTP router for the server composition root and route tests.
 * Paths are relative to the module's `/api/file-tree` mount point so the
 * complete HTTP surface has one feature-owned namespace.
 */
export function createFileTreeRouter(
  services: FileTreeServices,
  uploadFilesMiddleware: RequestHandler,
  uploadLimits: FileTreeUploadLimits,
  logger: FileTreeLogger,
): express.Router {
  const router = express.Router();

  router.get('/browse-filesystem', createRouteHandler(async (request, response) => {
    response.json(await services.browseWorkspace(readOptionalString(request.query.path)));
  }, logger));

  router.post('/create-folder', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    const folderPath = readRequiredString(body.path, 'path', 'Path is required');
    response.json(await services.createWorkspaceFolder(folderPath));
  }, logger));

  router.get('/projects/:projectId/file', createRouteHandler(async (request, response) => {
    const filePath = readRequiredString(request.query.filePath, 'filePath', 'Invalid file path');
    response.json(await services.readTextFile(readProjectId(request), filePath));
  }, logger));

  router.get('/projects/:projectId/files/content', createRouteHandler(async (request, response) => {
    const filePath = readRequiredString(request.query.path, 'path', 'Invalid file path');
    const file = await services.openFile(readProjectId(request), filePath);
    response.setHeader('Content-Type', file.contentType);
    file.stream.pipe(response);
    file.stream.on('error', (error) => {
      logger.error('Error streaming File Tree content', error);
      if (!response.headersSent) {
        response.status(500).json({ error: 'Error reading file' });
      }
    });
  }, logger));

  router.put('/projects/:projectId/file', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    const filePath = readRequiredString(body.filePath, 'filePath', 'Invalid file path');
    if (body.content === undefined) {
      throw new AppError('Content is required', {
        code: 'FILE_CONTENT_REQUIRED',
        statusCode: 400,
      });
    }
    if (typeof body.content !== 'string') {
      throw new AppError('Content must be a string', {
        code: 'INVALID_FILE_CONTENT',
        statusCode: 400,
      });
    }
    response.json(await services.saveTextFile(readProjectId(request), filePath, body.content));
  }, logger));

  router.get('/projects/:projectId/files', createRouteHandler(async (request, response) => {
    response.json(await services.listProjectFiles(readProjectId(request), readFileTreeOptions(request)));
  }, logger));

  router.get('/projects/:projectId/files/page', createRouteHandler(async (request, response) => {
    response.json(await services.listProjectFilePage(
      readProjectId(request),
      readFileTreePageOptions(request),
    ));
  }, logger));

  router.post('/projects/:projectId/files/create', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    if (!body.name || !body.type) {
      throw new AppError('Name and type are required', {
        code: 'FILE_TREE_ENTRY_FIELDS_REQUIRED',
        statusCode: 400,
      });
    }
    const name = readRequiredString(body.name, 'name');
    const type = readEntryType(body.type);
    const parentPath = readOptionalString(body.path) ?? '';
    response.json(await services.createEntry({
      projectId: readProjectId(request),
      parentPath,
      type,
      name,
    }));
  }, logger));

  router.put('/projects/:projectId/files/rename', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    if (!body.oldPath || !body.newName) {
      throw new AppError('oldPath and newName are required', {
        code: 'FILE_TREE_RENAME_FIELDS_REQUIRED',
        statusCode: 400,
      });
    }
    response.json(await services.renameEntry({
      projectId: readProjectId(request),
      oldPath: readRequiredString(body.oldPath, 'oldPath'),
      newName: readRequiredString(body.newName, 'newName'),
    }));
  }, logger));

  router.delete('/projects/:projectId/files', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    const targetPath = readRequiredString(body.path, 'path', 'Path is required');
    response.json(await services.deleteEntry({
      projectId: readProjectId(request),
      targetPath,
    }));
  }, logger));

  const uploadHandler = createRouteHandler(async (request, response) => {
    const uploadedRequest = request as UploadedRequest;
    const body = readBody(request);
    const files = normalizeUploadedFiles(uploadedRequest);
    response.json(await services.storeUploadedFiles({
      projectId: readProjectId(request),
      targetPath: readOptionalString(body.targetPath) ?? '',
      relativePaths: readRelativePaths(body.relativePaths),
      requestedFileCount: readRequestedFileCount(body.requestedFileCount, files.length),
      files,
    }));
  }, logger);

  router.post(
    '/projects/:projectId/files/upload',
    (request: Request, response: Response, next: NextFunction) => {
      uploadFilesMiddleware(request, response, (error?: unknown) => {
        if (!error) {
          void uploadHandler(request, response, next);
          return;
        }

        const errorCode = typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : null;
        if (errorCode === 'LIMIT_FILE_SIZE') {
          response.status(400).json({
            error: `File too large. Maximum size is ${uploadLimits.maximumFileSizeMegabytes}MB.`,
          });
          return;
        }
        if (errorCode === 'LIMIT_FILE_COUNT') {
          response.status(400).json({
            error: `Too many files. Maximum is ${uploadLimits.maximumFileCount} files.`,
          });
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        response.status(500).json({ error: message });
      });
    },
  );

  return router;
}
