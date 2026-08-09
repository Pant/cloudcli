import { createHash } from 'node:crypto';

import { mutationReceiptsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { chatRunLifecycleService } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/utils.js';

import type { SessionRenameMutationResult, SessionStartMutationResult } from '../../../../shared/cloudcli-contracts.js';

type MutationMetadata = { scope: string; idempotencyKey?: string; clientMutationId?: string };
type AuthenticatedIdentity = string | number | null;

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function idempotent<T extends Record<string, unknown>>(
  operation: string,
  metadata: MutationMetadata,
  request: unknown,
  httpStatus: number,
  execute: () => Promise<T> | T,
): Promise<{ httpStatus: number; payload: T }> {
  if (!metadata.idempotencyKey) return { httpStatus, payload: await execute() };
  const requestFingerprint = fingerprint(request);
  const receipt = { scope: metadata.scope, operation, key: metadata.idempotencyKey, fingerprint: requestFingerprint };
  const claim = mutationReceiptsDb.claim(receipt);
  if (claim.kind === 'fingerprint_conflict') throw new AppError('Idempotency key was already used with different input.', { code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 });
  if (claim.kind === 'in_progress') throw new AppError('An identical mutation is still in progress.', { code: 'MUTATION_IN_PROGRESS', statusCode: 409, details: { retryable: true } });
  if (claim.kind === 'completed') return { httpStatus: claim.result.httpStatus, payload: claim.result.payload as T };
  try {
    const payload = await execute();
    mutationReceiptsDb.complete({ ...receipt, result: { httpStatus, payload } });
    mutationReceiptsDb.cleanup();
    return { httpStatus, payload };
  } catch (error) {
    mutationReceiptsDb.abandon(receipt);
    throw error;
  }
}

/** Providers mutation orchestration keeps durable idempotency and revision checks out of routes. */
export const sessionMutationsService = {
  start(sessionId: string, metadata: MutationMetadata, userId: AuthenticatedIdentity = null): Promise<{ httpStatus: number; payload: SessionStartMutationResult }> {
    return idempotent('session.start', metadata, { sessionId }, 202, async () => {
      const result = await chatRunLifecycleService.manualStart(sessionId, userId);
      return { ...result, ...(metadata.clientMutationId ? { clientMutationId: metadata.clientMutationId } : {}) };
    });
  },

  rename(sessionId: string, summary: string, expectedRevision: string | undefined, metadata: MutationMetadata): Promise<{ httpStatus: number; payload: SessionRenameMutationResult }> {
    return idempotent('session.rename', metadata, { sessionId, summary, expectedRevision: expectedRevision ?? null }, 200, () => {
      const currentRevision = sessionsService.getHistoryRevision(sessionId);
      if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
        throw new AppError('Session was changed by another request.', {
          code: 'SESSION_REVISION_CONFLICT', statusCode: 409,
          details: { currentRevision, session: sessionsService.getSessionDetailsById(sessionId) },
        });
      }
      sessionsService.renameSessionById(sessionId, summary);
      const session = sessionsService.getSessionDetailsById(sessionId);
      return {
        sessionId: session.sessionId, summary: session.summary,
        revision: sessionsService.getHistoryRevision(sessionId),
        ...(metadata.clientMutationId ? { clientMutationId: metadata.clientMutationId } : {}),
      };
    });
  },
};
