import type { Plan, PlanEntitlements } from '@spectra/contracts';

/**
 * The built-in plan catalog.
 *
 * Shipped as code so a deployment has sane limits before anyone configures
 * anything, and so the free plan — the fallback when no subscription entitles
 * one — always exists. A deployment overrides these with database rows; the
 * numbers here are starting points, not pricing advice.
 */

export const BUILT_IN_PLAN_KEYS = ['free', 'starter', 'growth', 'scale'] as const;

type CatalogPlan = Omit<Plan, 'id'>;

const free: PlanEntitlements = {
  WORKSPACE_COUNT: 1,
  USER_COUNT: 2,
  CUSTOM_VERTICAL_COUNT: 1,
  SOCIAL_CONNECTION_COUNT: 1,
  RESEARCH_RUNS_PER_PERIOD: 5,
  CONTENT_GENERATIONS_PER_PERIOD: 20,
  MEDIA_RENDERS_PER_PERIOD: 20,
  PUBLISHING_ATTEMPTS_PER_PERIOD: 10,
  STORAGE_BYTES: 1024 * 1024 * 1024,
  ANALYTICS_SYNC_MIN_INTERVAL_MINUTES: 1440,
};

const starter: PlanEntitlements = {
  WORKSPACE_COUNT: 3,
  USER_COUNT: 5,
  CUSTOM_VERTICAL_COUNT: 5,
  SOCIAL_CONNECTION_COUNT: 5,
  RESEARCH_RUNS_PER_PERIOD: 50,
  CONTENT_GENERATIONS_PER_PERIOD: 300,
  MEDIA_RENDERS_PER_PERIOD: 300,
  PUBLISHING_ATTEMPTS_PER_PERIOD: 300,
  STORAGE_BYTES: 25 * 1024 * 1024 * 1024,
  ANALYTICS_SYNC_MIN_INTERVAL_MINUTES: 360,
};

const growth: PlanEntitlements = {
  WORKSPACE_COUNT: 10,
  USER_COUNT: 25,
  CUSTOM_VERTICAL_COUNT: 25,
  SOCIAL_CONNECTION_COUNT: 25,
  RESEARCH_RUNS_PER_PERIOD: 300,
  CONTENT_GENERATIONS_PER_PERIOD: 2000,
  MEDIA_RENDERS_PER_PERIOD: 2000,
  PUBLISHING_ATTEMPTS_PER_PERIOD: 2000,
  STORAGE_BYTES: 250 * 1024 * 1024 * 1024,
  ANALYTICS_SYNC_MIN_INTERVAL_MINUTES: 60,
};

const scale: PlanEntitlements = {
  WORKSPACE_COUNT: null,
  USER_COUNT: null,
  CUSTOM_VERTICAL_COUNT: null,
  SOCIAL_CONNECTION_COUNT: null,
  RESEARCH_RUNS_PER_PERIOD: 2000,
  CONTENT_GENERATIONS_PER_PERIOD: null,
  MEDIA_RENDERS_PER_PERIOD: null,
  PUBLISHING_ATTEMPTS_PER_PERIOD: null,
  STORAGE_BYTES: 2048 * 1024 * 1024 * 1024,
  ANALYTICS_SYNC_MIN_INTERVAL_MINUTES: 15,
};

export const BUILT_IN_PLANS: readonly CatalogPlan[] = [
  {
    key: 'free',
    tier: 'FREE',
    name: 'Free',
    description:
      'What an organization gets with no subscription. Also the fallback when a subscription lapses.',
    monthlyCredits: 100,
    entitlements: free,
    selfServe: true,
    active: true,
    sortOrder: 0,
  },
  {
    key: 'starter',
    tier: 'STARTER',
    name: 'Starter',
    description: 'A small team running regular research and publishing.',
    monthlyCredits: 2000,
    entitlements: starter,
    selfServe: true,
    active: true,
    sortOrder: 1,
  },
  {
    key: 'growth',
    tier: 'GROWTH',
    name: 'Growth',
    description: 'Multiple workspaces, several brands, hourly analytics.',
    monthlyCredits: 15_000,
    entitlements: growth,
    selfServe: true,
    active: true,
    sortOrder: 2,
  },
  {
    key: 'scale',
    tier: 'SCALE',
    name: 'Scale',
    description: 'Unlimited seats and workspaces; generation and rendering uncapped.',
    monthlyCredits: 100_000,
    entitlements: scale,
    selfServe: true,
    active: true,
    sortOrder: 3,
  },
] as const;

/** The plan that applies when nothing else does. Never "unlimited". */
export const FALLBACK_PLAN_KEY = 'free';

export function builtInPlan(key: string): CatalogPlan | undefined {
  return BUILT_IN_PLANS.find((plan) => plan.key === key);
}
