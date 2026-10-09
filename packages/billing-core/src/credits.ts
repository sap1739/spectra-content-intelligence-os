import { CREDIT_EXPIRY_POLICY, type CreditSource } from '@spectra/contracts';

/**
 * Credit ledger arithmetic. Pure, so the deduction order is testable and the
 * same wherever it runs.
 *
 * The ordering rule matters commercially: credits are spent **soonest-expiring
 * first**, so a customer's monthly allowance is consumed before the credits
 * they paid for. Spending purchased credits while free ones silently lapse is
 * the kind of default that is technically defensible and plainly unfair.
 */

export interface LedgerGrant {
  id: string;
  source: CreditSource;
  remaining: number;
  /** Null means it never expires. */
  expiresAt: Date | null;
  grantedAt: Date;
}

export interface Deduction {
  grantId: string;
  amount: number;
}

export interface DeductionPlan {
  /** Which grants to draw from, in order. */
  deductions: Deduction[];
  /** Credits the ledger could not cover. Zero when the balance was enough. */
  shortfall: number;
  /** Balance after this deduction, assuming it is applied in full. */
  remainingAfter: number;
}

/** Grants still spendable at `now`, soonest-expiring first. */
export function spendableGrants(grants: readonly LedgerGrant[], now: Date): LedgerGrant[] {
  return grants
    .filter((grant) => grant.remaining > 0 && !isExpired(grant, now))
    .sort((a, b) => {
      // A grant that expires outranks one that never does, however old.
      if (a.expiresAt && b.expiresAt) {
        const byExpiry = a.expiresAt.getTime() - b.expiresAt.getTime();
        if (byExpiry !== 0) return byExpiry;
      } else if (a.expiresAt) return -1;
      else if (b.expiresAt) return 1;
      // Then oldest first, so the ledger drains in a stable order.
      return a.grantedAt.getTime() - b.grantedAt.getTime();
    });
}

export function isExpired(grant: LedgerGrant, now: Date): boolean {
  return grant.expiresAt !== null && grant.expiresAt.getTime() <= now.getTime();
}

export function availableCredits(grants: readonly LedgerGrant[], now: Date): number {
  return spendableGrants(grants, now).reduce((sum, grant) => sum + grant.remaining, 0);
}

/**
 * Plans a deduction without applying it. A shortfall is reported rather than
 * throwing or silently partially-charging — the caller decides whether to
 * refuse the work or let it through.
 */
export function planDeduction(
  grants: readonly LedgerGrant[],
  amount: number,
  now: Date,
): DeductionPlan {
  if (amount <= 0) {
    return { deductions: [], shortfall: 0, remainingAfter: availableCredits(grants, now) };
  }
  const spendable = spendableGrants(grants, now);
  const deductions: Deduction[] = [];
  let outstanding = amount;

  for (const grant of spendable) {
    if (outstanding <= 0) break;
    const take = Math.min(grant.remaining, outstanding);
    deductions.push({ grantId: grant.id, amount: take });
    outstanding -= take;
  }

  const total = spendable.reduce((sum, grant) => sum + grant.remaining, 0);
  return {
    deductions,
    shortfall: Math.max(0, outstanding),
    remainingAfter: Math.max(0, total - (amount - Math.max(0, outstanding))),
  };
}

/**
 * Plans a reversal — credits returned because work was refunded or failed
 * after being charged. Returned to the grants they came from where those are
 * still live, so a reversal cannot extend a lapsed grant's life.
 */
export function planReversal(
  original: readonly Deduction[],
  grants: readonly LedgerGrant[],
  now: Date,
): { restorations: Deduction[]; unrestorable: number } {
  const byId = new Map(grants.map((grant) => [grant.id, grant]));
  const restorations: Deduction[] = [];
  let unrestorable = 0;

  for (const deduction of original) {
    const grant = byId.get(deduction.grantId);
    if (!grant || isExpired(grant, now)) {
      // The grant it came from is gone. Returning it to a different grant
      // would quietly extend credits past their expiry, so it is reported
      // instead and the caller issues a fresh REVERSAL grant if it chooses.
      unrestorable += deduction.amount;
      continue;
    }
    restorations.push({ grantId: grant.id, amount: deduction.amount });
  }
  return { restorations, unrestorable };
}

/** When a grant from this source should lapse, given the current period end. */
export function expiryFor(
  source: CreditSource,
  periodEnd: Date | null,
  explicit: Date | null,
): Date | null {
  switch (CREDIT_EXPIRY_POLICY[source]) {
    case 'PERIOD_END':
      return periodEnd;
    case 'EXPLICIT':
      return explicit;
    case 'NEVER':
      return null;
  }
}

/** Credits that will lapse at the end of the current period. */
export function expiringBy(
  grants: readonly LedgerGrant[],
  periodEnd: Date | null,
  now: Date,
): number {
  if (!periodEnd) return 0;
  return spendableGrants(grants, now)
    .filter((grant) => grant.expiresAt !== null && grant.expiresAt.getTime() <= periodEnd.getTime())
    .reduce((sum, grant) => sum + grant.remaining, 0);
}
