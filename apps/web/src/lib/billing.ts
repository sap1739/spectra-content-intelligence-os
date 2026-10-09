'use client';

import type {
  BillingInterval,
  CreateCheckoutSessionInput,
  EntitlementDecision,
  EntitlementDefinition,
  EntitlementKey,
  GrantCreditsInput,
  PlanTier,
  SubscriptionStatus,
} from '@spectra/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type ApiError } from './api';

/** Billing, plans, credits and entitlements (Phase 8A, ADR-0044). */

const base = (organizationId: string) => `/v1/organizations/${organizationId}/billing`;
const key = (organizationId: string, ...rest: string[]) => [
  'organizations',
  organizationId,
  'billing',
  ...rest,
];

export interface BillingCapabilities {
  provider: {
    available: boolean;
    reason: string;
    providerId: string;
    mode: 'TEST' | 'LIVE' | null;
    requiredEnv: string[];
    webhooksVerifiable: boolean;
  };
  /** The sentence the UI must show wherever usage and billing sit together. */
  estimatesAreNotInvoices: string;
  fallbackPlanKey: string;
  entitlementDefinitions: Record<EntitlementKey, EntitlementDefinition>;
}

export interface PlanRow {
  id: string;
  key: string;
  tier: PlanTier;
  name: string;
  description: string | null;
  monthlyCredits: number;
  entitlements: Record<string, number | null>;
  selfServe: boolean;
  purchasable: boolean;
  prices: Array<{
    id: string;
    currency: string;
    unitAmount: number;
    interval: BillingInterval;
  }>;
}

export interface SubscriptionState {
  subscription: {
    id: string;
    status: SubscriptionStatus;
    planKey: string;
    planName: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    trialEndsAt: string | null;
    lastPaymentFailedAt: string | null;
    lastPaymentFailureMessage: string | null;
    mode: 'TEST' | 'LIVE';
  } | null;
  effectivePlanKey: string;
  downgradedToFallback: boolean;
  paymentFailed: boolean;
}

export interface CreditState {
  balance: {
    available: number;
    consumedThisPeriod: number;
    expiringAtPeriodEnd: number;
    asOf: string;
  };
  grants: Array<{ id: string; source: string; remaining: number; expiresAt: string | null }>;
}

export function useBillingCapabilities(organizationId: string) {
  return useQuery<BillingCapabilities, ApiError>({
    queryKey: key(organizationId, 'capabilities'),
    queryFn: () => api.get(`${base(organizationId)}/capabilities`),
    staleTime: 300_000,
  });
}

export function usePlans(organizationId: string) {
  return useQuery<{ plans: PlanRow[]; mode: string | null }, ApiError>({
    queryKey: key(organizationId, 'plans'),
    queryFn: () => api.get(`${base(organizationId)}/plans`),
  });
}

export function useSubscription(organizationId: string) {
  return useQuery<SubscriptionState, ApiError>({
    queryKey: key(organizationId, 'subscription'),
    queryFn: () => api.get(`${base(organizationId)}/subscription`),
  });
}

export function useEntitlements(organizationId: string) {
  return useQuery<{ planKey: string; decisions: EntitlementDecision[] }, ApiError>({
    queryKey: key(organizationId, 'entitlements'),
    queryFn: () => api.get(`${base(organizationId)}/entitlements`),
  });
}

export function useCredits(organizationId: string) {
  return useQuery<CreditState, ApiError>({
    queryKey: key(organizationId, 'credits'),
    queryFn: () => api.get(`${base(organizationId)}/credits`),
  });
}

/** Returns a URL to send the browser to. Card entry happens on the provider. */
export function useCheckout(organizationId: string) {
  return useMutation<{ url: string }, ApiError, CreateCheckoutSessionInput>({
    mutationFn: (input) => api.post(`${base(organizationId)}/checkout`, input),
  });
}

export function usePortal(organizationId: string) {
  return useMutation<{ url: string }, ApiError, void>({
    mutationFn: () => api.post(`${base(organizationId)}/portal`),
  });
}

export function useGrantCredits(organizationId: string) {
  const client = useQueryClient();
  return useMutation<CreditState, ApiError, GrantCreditsInput>({
    mutationFn: (input) => api.post(`${base(organizationId)}/credits/grant`, input),
    onSuccess: () => client.invalidateQueries({ queryKey: key(organizationId) }),
  });
}

export const SUBSCRIPTION_VARIANT: Record<
  SubscriptionStatus,
  'success' | 'warning' | 'destructive' | 'muted'
> = {
  ACTIVE: 'success',
  TRIALING: 'success',
  PAST_DUE: 'warning',
  INCOMPLETE: 'warning',
  PAUSED: 'warning',
  UNPAID: 'destructive',
  CANCELED: 'muted',
  INCOMPLETE_EXPIRED: 'muted',
};

export function formatMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
  }).format(minor / 100);
}

/** Entitlement limits render as counts, bytes or minutes depending on the key. */
export function formatLimit(key: EntitlementKey, value: number | null): string {
  if (value === null) return 'Unlimited';
  if (key === 'STORAGE_BYTES') {
    const gb = value / (1024 * 1024 * 1024);
    return gb >= 1
      ? `${gb.toFixed(gb < 10 ? 1 : 0)} GB`
      : `${(value / (1024 * 1024)).toFixed(0)} MB`;
  }
  if (key === 'ANALYTICS_SYNC_MIN_INTERVAL_MINUTES') {
    return value >= 60 ? `every ${Math.round(value / 60)}h` : `every ${value}m`;
  }
  return value.toLocaleString();
}
