import fsSync, { promises as fs } from 'node:fs';
import path from 'node:path';

import mime from 'mime-types';
import sharp from 'sharp';

import { getGlobalImageAssetsDir, toPosixPath } from '@/shared/image-attachments.js';

/**
 * Image mime types accepted for chat attachment uploads. SVG is allowed for
 * storage/preview even though some providers (Claude API) skip it at send time.
 */
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

const THUMBNAIL_SIZE = 224;
const MAX_THUMBNAIL_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_THUMBNAIL_CACHE_ENTRIES = 100;

type CachedThumbnail = {
  buffer: Buffer;
  contentType: string;
  sourceModifiedMs: number;
  sourceSize: number;
};

const thumbnailCache = new Map<string, CachedThumbnail>();

// Used only by this service and the assets routes via the barrel file.
type StoredImageAsset = {
  /** Original upload filename, for display. */
  name: string;
  /** Absolute posix-normalized path inside the global assets folder. */
  path: string;
  size: number;
  mimeType: string;
};

// Shape of one multer-stored file; kept local because only this module reads it.
type UploadedImageFile = {
  originalname: string;
  filename: string;
  size: number;
  mimetype: string;
};

type UploadedAttachmentFile = UploadedImageFile;

/** Returns whether one uploaded mime type may be stored as a chat image asset. */
export function isAllowedImageMimeType(mimeType: string): boolean {
  return ALLOWED_IMAGE_MIME_TYPES.has(mimeType);
}

/** Creates the global `~/.cloudcli/assets` folder if needed and returns it. */
export async function ensureImageAssetsDir(): Promise<string> {
  const assetsDir = getGlobalImageAssetsDir();
  await fs.mkdir(assetsDir, { recursive: true });
  return assetsDir;
}

/**
 * Maps multer-stored upload files to the attachment records returned to the
 * chat composer. The absolute path is what providers receive and what session
 * history carries back to the UI.
 */
export function buildStoredImageRecords(files: UploadedImageFile[]): StoredImageAsset[] {
  const assetsDir = getGlobalImageAssetsDir();
  return files.map((file) => ({
    name: file.originalname,
    path: toPosixPath(path.join(assetsDir, file.filename)),
    size: file.size,
    mimeType: file.mimetype,
  }));
}

/**
 * Maps multer-stored files to provider-neutral attachment records for the
 * assets route. The shared storage format intentionally matches image records
 * so one uploaded file can move through queueing and provider dispatch.
 */
export function buildStoredAttachmentRecords(files: UploadedAttachmentFile[]): StoredImageAsset[] {
  return buildStoredImageRecords(files);
}

/**
 * Resolves one asset filename to its absolute path inside the global assets
 * folder, or null when the name is empty, contains path separators/traversal,
 * or would escape the folder. This is the only lookup the serving route uses,
 * so nothing outside `~/.cloudcli/assets` can ever be read through it.
 */
export function resolveImageAssetFile(filename: string): string | null {
  const trimmed = typeof filename === 'string' ? filename.trim() : '';
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    return null;
  }

  const assetsDir = path.resolve(getGlobalImageAssetsDir());
  const resolved = path.resolve(assetsDir, trimmed);
  if (!resolved.startsWith(assetsDir + path.sep)) {
    return null;
  }

  return resolved;
}

/**
 * Resolves a general chat attachment for the assets serving route. It shares
 * the image resolver's strict direct-child containment boundary.
 */
export function resolveAttachmentAssetFile(filename: string): string | null {
  return resolveImageAssetFile(filename);
}

/**
 * Opens one stored chat asset for the assets route without exposing arbitrary
 * filesystem reads. The route translates the lookup status and streams the
 * returned direct-child file to the authenticated client.
 */
export async function openStoredAttachmentAsset(filename: string) {
  const resolved = resolveAttachmentAssetFile(filename);
  if (!resolved) {
    return { status: 'invalid' as const };
  }

  try {
    await fs.access(resolved);
  } catch {
    return { status: 'missing' as const };
  }

  return {
    status: 'found' as const,
    contentType: mime.lookup(resolved) || 'application/octet-stream',
    stream: fsSync.createReadStream(resolved),
  };
}

/**
 * Builds a bounded, orientation-correct WebP preview for the authenticated
 * assets route. Unsupported/animated/vector inputs are reported explicitly so
 * callers can retain the original-image route's existing behavior.
 */
export async function openStoredImageThumbnail(filename: string) {
  const resolved = resolveImageAssetFile(filename);
  if (!resolved) {
    return { status: 'invalid' as const };
  }

  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    return { status: 'missing' as const };
  }

  const contentType = mime.lookup(resolved) || 'application/octet-stream';
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(contentType) || stat.size > MAX_THUMBNAIL_SOURCE_BYTES) {
    return { status: 'unsupported' as const };
  }

  const cached = thumbnailCache.get(resolved);
  if (cached && cached.sourceModifiedMs === stat.mtimeMs && cached.sourceSize === stat.size) {
    thumbnailCache.delete(resolved);
    thumbnailCache.set(resolved, cached);
    return { status: 'found' as const, contentType: cached.contentType, buffer: cached.buffer };
  }

  try {
    const buffer = await sharp(resolved, { animated: false, limitInputPixels: 40_000_000 })
      .rotate()
      .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: 'cover', withoutEnlargement: true })
      .webp({ quality: 78, effort: 4 })
      .toBuffer();
    const entry = { buffer, contentType: 'image/webp', sourceModifiedMs: stat.mtimeMs, sourceSize: stat.size };
    thumbnailCache.set(resolved, entry);
    while (thumbnailCache.size > MAX_THUMBNAIL_CACHE_ENTRIES) {
      const oldest = thumbnailCache.keys().next().value;
      if (typeof oldest !== 'string') break;
      thumbnailCache.delete(oldest);
    }
    return { status: 'found' as const, contentType: entry.contentType, buffer };
  } catch {
    return { status: 'unsupported' as const };
  }
}

/** Clears process-local thumbnail state for focused service validation. */
export function clearImageThumbnailCache(): void {
  thumbnailCache.clear();
}
