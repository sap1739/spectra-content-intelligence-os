import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Ambient request/job context propagated through async boundaries.
 * The API sets this per HTTP request; the worker sets it per job execution.
 */
export interface RequestContext {
  correlationId: string;
  organizationId?: string;
  workspaceId?: string;
  principalId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const CORRELATION_HEADER = 'x-correlation-id';

export function generateCorrelationId(): string {
  return randomUUID();
}

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}
