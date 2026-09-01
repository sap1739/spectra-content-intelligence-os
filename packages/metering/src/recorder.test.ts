import { describe, expect, it, vi } from 'vitest';

import { RATE_VERSION } from './rates';
import { NoopUsageRecorder, PrismaUsageRecorder } from './recorder';

const TENANT = { organizationId: 'org-1', workspaceId: 'ws-1' };

function fakePrisma() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    client: {
      usageEvent: {
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          rows.push(args.data);
          return args.data;
        }),
      },
    },
  };
}

describe('PrismaUsageRecorder', () => {
  it('prices a known provider and stamps the rate version', async () => {
    const p = fakePrisma();
    await new PrismaUsageRecorder(p.client as never).record(TENANT, {
      kind: 'AI_GENERATION',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      inputTokens: 1000,
      outputTokens: 100,
      resourceType: 'CONTENT_DRAFT',
      resourceId: 'draft-1',
    });
    const row = p.rows[0]!;
    expect(row['estimatedCostMicros']).toBe(1000 * 5 + 100 * 25);
    expect(row['rateVersion']).toBe(RATE_VERSION);
    expect(row['organizationId']).toBe('org-1');
    expect(row['workspaceId']).toBe('ws-1');
  });

  it('leaves cost and rate version null for an unpriced provider', async () => {
    const p = fakePrisma();
    await new PrismaUsageRecorder(p.client as never).record(TENANT, {
      kind: 'PAGE_FETCH',
      provider: 'first-party',
      requests: 1,
      bytes: 2048,
    });
    const row = p.rows[0]!;
    // No rate => no estimate, and no version claiming one was applied.
    expect(row['estimatedCostMicros']).toBeNull();
    expect(row['rateVersion']).toBeNull();
    expect(row['bytes']).toBe(2048);
  });

  it('records unreported token counts as null, never zero', async () => {
    const p = fakePrisma();
    await new PrismaUsageRecorder(p.client as never).record(TENANT, {
      kind: 'WEB_SEARCH',
      provider: 'brave',
      model: 'web-search',
    });
    const row = p.rows[0]!;
    expect(row['inputTokens']).toBeNull();
    expect(row['outputTokens']).toBeNull();
    expect(row['totalTokens']).toBeNull();
    // Search is request-priced, so it still gets an estimate.
    expect(row['estimatedCostMicros']).toBe(5000);
  });

  it('never lets a ledger failure break the work being measured', async () => {
    const client = {
      usageEvent: {
        create: vi.fn(async () => {
          throw new Error('db down');
        }),
      },
    };
    const warn = vi.fn();
    await expect(
      new PrismaUsageRecorder(client as never, { warn } as never).record(TENANT, {
        kind: 'AI_GENERATION',
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        inputTokens: 10,
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe('NoopUsageRecorder', () => {
  it('discards without error', async () => {
    await expect(new NoopUsageRecorder().record()).resolves.toBeUndefined();
  });
});
