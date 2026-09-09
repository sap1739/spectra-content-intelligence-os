import type { SpectraPrismaClient } from '@spectra/database';
import type { Logger } from '@spectra/logging';

import {
  BudgetBlockedError,
  preflight,
  type PreflightDecision,
  type PreflightRequest,
} from './preflight';
import type { UsageKind } from './recorder';

/**
 * Budget reservations — the concurrency guard.
 *
 * A reservation holds the estimated cost of in-flight work so the next
 * pre-flight sees it as already committed.
 *
 * ## Why this is transactional (ADR-0029)
 *
 * The first implementation checked the budget and wrote the hold in two
 * separate statements. Two operations could both READ the remaining allowance
 * before either WROTE its hold, both conclude there was room, and both proceed —
 * together exceeding a ceiling that each had individually respected. Holding an
 * estimate is useless if acquiring it is not atomic with the decision to allow.
 *
 * The whole decide-and-hold sequence now runs inside one transaction, guarded by
 * a PostgreSQL **transaction-scoped advisory lock keyed on `organizationId`**:
 *
 *  - Advisory rather than row locks, because a budget row may legitimately not
 *    exist (an unconfigured ceiling still needs per-kind limits enforced) and
 *    `SELECT … FOR UPDATE` cannot lock a row that isn't there.
 *  - Keyed on the ORGANIZATION, because the organization ceiling aggregates
 *    across that organization's workspaces — a workspace-scoped lock could not
 *    make that check safe.
 *  - Exactly ONE lock is taken per transaction, so deadlock is impossible by
 *    construction; there is no lock-ordering hazard to reason about.
 *  - Transaction-scoped (`pg_advisory_xact_lock`), so it is released on commit
 *    OR rollback — a crashed or erroring reserve cannot strand the lock.
 *
 * Because the lock serializes the critical section, the default READ COMMITTED
 * isolation is sufficient; SERIALIZABLE would add 40001 retry handling for no
 * additional safety here.
 *
 * Reservations are ADVISORY, not accounting: they hold an *estimate*, reconciled
 * against real metered usage on completion (the ledger stays the source of truth
 * for what was actually spent), and they expire so a crashed worker cannot
 * permanently consume an allowance.
 */

const DEFAULT_TTL_MS = 30 * 60_000;

/** Reservations are always addressed within a tenant — never by key alone. */
export interface ReservationScope {
  organizationId: string;
  workspaceId: string;
}

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
  /** True when an existing hold for this idempotency key was re-used. */
  reused: boolean;
}

/**
 * Atomically evaluates the budget and, if allowed, holds the estimated cost.
 *
 * Throws `BudgetBlockedError` when the operation must not proceed — the
 * transaction rolls back, so a blocked attempt never leaves a partial or
 * orphaned reservation behind.
 */
export async function reserve(
  prisma: SpectraPrismaClient,
  input: ReserveInput,
  now: Date = new Date(),
): Promise<Reservation> {
  return prisma.$transaction(async (tx) => {
    // Serialize every budget decision for this organization. Taken FIRST, so
    // the reads below cannot observe a state another reserve is midway through
    // changing.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.organizationId}, 0))`;

    // Idempotency BEFORE the decision: a retry must re-use its own hold rather
    // than re-evaluating against a budget its own reservation is inflating —
    // otherwise a retried job could be blocked by itself.
    const existing = await tx.budgetReservation.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      if (
        existing.organizationId !== input.organizationId ||
        existing.workspaceId !== input.workspaceId
      ) {
        // Keys are caller-generated; never hand back another tenant's hold.
        throw new Error('Reservation idempotency key belongs to a different tenant');
      }
      const decision = await preflight(tx, input, now);
      return { id: existing.id, decision, reused: true };
    }

    const decision = await preflight(tx, input, now);
    // Rolls the transaction back: decision and hold are all-or-nothing.
    if (decision.blocked) throw new BudgetBlockedError(decision);

    const created = await tx.budgetReservation.create({
      data: {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        kind: input.kind,
        // Unpriceable work holds 0 cost but still holds its request count —
        // the only limit that can bound an operation we cannot price.
        estimatedCostMicros: decision.estimatedCostMicros ?? 0,
        requests: input.requests ?? 1,
        idempotencyKey: input.idempotencyKey,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        expiresAt: new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS)),
      },
    });
    return { id: created.id, decision, reused: false };
  });
}

/**
 * Marks a reservation reconciled: the work finished and its real usage is in
 * the ledger, so the hold must stop counting — otherwise the same spend is
 * counted twice, once as an estimate and once as the actual event.
 *
 * Safe to call for every terminal outcome, including failure after the provider
 * was already charged: the ledger holds whatever was really spent.
 */
export async function reconcile(
  prisma: Pick<SpectraPrismaClient, 'budgetReservation'>,
  scope: ReservationScope,
  idempotencyKey: string,
  logger?: Logger,
): Promise<void> {
  await settle(prisma, scope, idempotencyKey, 'RECONCILED', logger);
}

/**
 * Returns the allowance when work never ran — refused, cancelled, or failed
 * before any provider call. Nothing was spent, so nothing should stay held.
 */
export async function release(
  prisma: Pick<SpectraPrismaClient, 'budgetReservation'>,
  scope: ReservationScope,
  idempotencyKey: string,
  logger?: Logger,
): Promise<void> {
  await settle(prisma, scope, idempotencyKey, 'RELEASED', logger);
}

async function settle(
  prisma: Pick<SpectraPrismaClient, 'budgetReservation'>,
  scope: ReservationScope,
  idempotencyKey: string,
  status: 'RECONCILED' | 'RELEASED',
  logger?: Logger,
): Promise<void> {
  try {
    await prisma.budgetReservation.updateMany({
      // Tenant-scoped: an idempotency key alone must never address a hold.
      where: {
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        idempotencyKey,
        status: 'ACTIVE',
      },
      data: { status, releasedAt: new Date() },
    });
  } catch (error) {
    // Never fail the work over bookkeeping — the hold expires regardless.
    logger?.warn(
      { idempotencyKey, status, err: error instanceof Error ? error.message : String(error) },
      'Could not settle budget reservation — it will expire',
    );
  }
}

/**
 * Reserve, run, then reconcile on success or release on failure.
 *
 * `failedBeforeSpend` distinguishes the two failure shapes: work that never
 * reached a provider releases its hold (nothing was spent), while work that
 * failed after a provider call reconciles (something was, and the ledger has
 * it). Defaults to reconciling, which is the safe direction — it can only
 * under-hold, never let spend escape the ceiling twice.
 */
export async function withReservation<T>(
  prisma: SpectraPrismaClient,
  input: ReserveInput,
  run: (decision: PreflightDecision) => Promise<T>,
  options: { logger?: Logger; failedBeforeSpend?: (error: unknown) => boolean } = {},
): Promise<T> {
  const scope = { organizationId: input.organizationId, workspaceId: input.workspaceId };
  const { decision } = await reserve(prisma, input);
  try {
    const result = await run(decision);
    await reconcile(prisma, scope, input.idempotencyKey, options.logger);
    return result;
  } catch (error) {
    if (options.failedBeforeSpend?.(error) ?? true) {
      await release(prisma, scope, input.idempotencyKey, options.logger);
    } else {
      await reconcile(prisma, scope, input.idempotencyKey, options.logger);
    }
    throw error;
  }
}

/**
 * Marks expired holds as released so they stop counting.
 *
 * Pre-flight already ignores expired reservations, so this is hygiene rather
 * than correctness — it keeps the table interpretable and bounded.
 */
export async function expireStaleReservations(
  prisma: Pick<SpectraPrismaClient, '$executeRaw'>,
  now: Date = new Date(),
): Promise<number> {
  // Deliberately raw: this is a cross-tenant maintenance sweep, and
  // BudgetReservation is tenant-guarded, so the model API would (correctly)
  // refuse an un-scoped updateMany. The statement touches only expiry
  // bookkeeping and reads no tenant content.
  return prisma.$executeRaw`
    UPDATE "budget_reservations"
       SET "status" = 'RELEASED', "releasedAt" = ${now}
     WHERE "status" = 'ACTIVE' AND "expiresAt" <= ${now}`;
}

export { BudgetBlockedError };
export type { UsageKind };
