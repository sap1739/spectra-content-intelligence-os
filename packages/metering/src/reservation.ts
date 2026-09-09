import type { SpectraPrismaClient } from '@spectra/database';
import type { Logger } from '@spectra/logging';

import {
  BudgetBlockedError,
  assertPreflight,
  type PreflightDecision,
  type PreflightRequest,
} from './preflight';
import type { UsageKind } from './recorder';

/**
 * Budget reservations — the concurrency guard.
 *
 * Without them, two operations can pass pre-flight at the same instant against
 * the same remaining allowance and both proceed, together exceeding the
 * ceiling. A reservation holds the estimated cost for in-flight work so the
 * next pre-flight sees it as already committed.
 *
 * Reservations are ADVISORY, not accounting:
 *  - they hold an *estimate*, reconciled against real metered usage on
 *    completion (the ledger remains the source of truth for what was spent);
 *  - they expire, so a crashed worker cannot permanently consume an allowance;
 *  - they are keyed by an idempotency key, so a retried job re-uses its own
 *    reservation instead of holding a second one.
 */

const DEFAULT_TTL_MS = 30 * 60_000;

export interface ReserveInput extends PreflightRequest {
  /** Stable per logical operation, so retries do not double-reserve. */
  idempotencyKey: string;
  resourceType?: string;
  resourceId?: string;
  ttlMs?: number;
}

export interface Reservation {
  id: string;
  decision: PreflightDecision;
}

/**
 * Runs pre-flight and, if allowed, holds the estimated cost.
 * Throws `BudgetBlockedError` when the operation must not proceed.
 */
export async function reserve(
  prisma: SpectraPrismaClient,
  input: ReserveInput,
  now: Date = new Date(),
): Promise<Reservation> {
  const decision = await assertPreflight(prisma, input, now);

  const existing = await prisma.budgetReservation.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) {
    // A retry of the same logical operation: re-use its hold rather than
    // stacking a second one against the same allowance.
    return { id: existing.id, decision };
  }

  const created = await prisma.budgetReservation.create({
    data: {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      // Unpriceable work holds 0 cost but still holds its request count, which
      // is the only limit that can bound an operation we cannot price.
      estimatedCostMicros: decision.estimatedCostMicros ?? 0,
      requests: input.requests ?? 1,
      idempotencyKey: input.idempotencyKey,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      expiresAt: new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS)),
    },
  });
  return { id: created.id, decision };
}

/**
 * Marks a reservation reconciled: the work finished and its real usage is in
 * the ledger, so the hold must stop counting (otherwise spend is double-counted
 * — once as a reservation, once as the actual event).
 */
export async function reconcile(
  prisma: SpectraPrismaClient,
  idempotencyKey: string,
  logger?: Logger,
): Promise<void> {
  try {
    await prisma.budgetReservation.updateMany({
      where: { idempotencyKey, status: 'ACTIVE' },
      data: { status: 'RECONCILED', releasedAt: new Date() },
    });
  } catch (error) {
    // Never fail the work over bookkeeping; the reservation expires anyway.
    logger?.warn(
      { idempotencyKey, err: error instanceof Error ? error.message : String(error) },
      'Could not reconcile budget reservation — it will expire',
    );
  }
}

/** Returns the allowance when work never ran (refused, failed before spending). */
export async function release(
  prisma: SpectraPrismaClient,
  idempotencyKey: string,
  logger?: Logger,
): Promise<void> {
  try {
    await prisma.budgetReservation.updateMany({
      where: { idempotencyKey, status: 'ACTIVE' },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });
  } catch (error) {
    logger?.warn(
      { idempotencyKey, err: error instanceof Error ? error.message : String(error) },
      'Could not release budget reservation — it will expire',
    );
  }
}

/**
 * Convenience wrapper: reserve, run, then reconcile on success or release on
 * failure. Guarantees the hold is not leaked by an early return or a throw.
 */
export async function withReservation<T>(
  prisma: SpectraPrismaClient,
  input: ReserveInput,
  run: (decision: PreflightDecision) => Promise<T>,
  logger?: Logger,
): Promise<T> {
  const { decision } = await reserve(prisma, input);
  try {
    const result = await run(decision);
    await reconcile(prisma, input.idempotencyKey, logger);
    return result;
  } catch (error) {
    await release(prisma, input.idempotencyKey, logger);
    throw error;
  }
}

export { BudgetBlockedError };
export type { UsageKind };
