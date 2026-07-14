import './setup-env';

import { randomBytes } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { executePublication } from '@spectra/publishing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase 4B publishing pipeline. No platform adapter is wired, so a publish
 * attempt resolves to an honest UNSUPPORTED — never a fabricated PUBLISHED.
 */

const runId = randomBytes(4).toString('hex');
const ownerEmail = `pub-owner-${runId}@itest.local`;
const PASSWORD = 'integration-test-password-1';

interface MeBody {
  memberships: Array<{ organizationId: string }>;
  workspaces: Array<{ id: string }>;
}

function cookieOf(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) throw new Error('expected a set-cookie header');
  return raw.split(';')[0] as string;
}

describe('API integration: publishing pipeline, honest UNSUPPORTED', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let cookie = '';
  let orgId = '';
  let workspaceId = '';
  let itemId = '';
  let accountId = '';

  const inject = () => app.getHttpAdapter().getInstance();

  beforeAll(async () => {
    app = await createApp(getApiEnv());
    await app.init();
    await inject().ready();
    prisma = app.get(PrismaService);

    const register = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: ownerEmail, password: PASSWORD, name: 'Pub Owner' },
    });
    cookie = cookieOf(register.headers['set-cookie']);
    const me = register.json() as MeBody;
    orgId = me.memberships[0]?.organizationId as string;
    workspaceId = me.workspaces[0]?.id as string;

    const item = await prisma.client.contentItem.create({
      data: {
        organizationId: orgId,
        workspaceId,
        title: 'Publishable item',
        contentType: 'POST',
        lifecycleState: 'APPROVED',
        body: 'Hello world.',
      },
    });
    itemId = item.id;
    const account = await prisma.client.socialAccount.create({
      data: {
        organizationId: orgId,
        workspaceId,
        platform: 'LINKEDIN',
        externalAccountId: 'acme',
        displayName: 'Acme',
        status: 'PENDING',
      },
    });
    accountId = account.id;
  });

  afterAll(async () => {
    await prisma.client.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    await prisma.client.user.delete({ where: { email: ownerEmail } }).catch(() => undefined);
    await app.close();
  });

  async function schedule(withAccount: boolean): Promise<string> {
    const res = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/calendar`,
      headers: { cookie },
      payload: {
        contentItemId: itemId,
        platform: 'LINKEDIN',
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
        ...(withAccount ? { socialAccountId: accountId } : {}),
      },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  }

  it('schedules a targeted entry with an idempotency key', async () => {
    const entryId = await schedule(true);
    const row = await prisma.client.contentScheduleEntry.findUnique({ where: { id: entryId } });
    expect(row?.socialAccountId).toBe(accountId);
    expect(row?.idempotencyKey).toBeTruthy();
  });

  it('publish-now queues the entry, then the worker resolves it to UNSUPPORTED', async () => {
    const entryId = await schedule(true);

    const publish = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/calendar/${entryId}/publish`,
      headers: { cookie },
    });
    expect(publish.statusCode).toBe(201);
    expect((publish.json() as { status: string }).status).toBe('QUEUED');

    // Run the executor the worker would run (no adapter → honest UNSUPPORTED).
    const outcome = await executePublication({ prisma: prisma.client }, { entryId });
    expect(outcome.status).toBe('UNSUPPORTED');

    const row = await prisma.client.contentScheduleEntry.findUnique({ where: { id: entryId } });
    expect(row?.status).toBe('UNSUPPORTED');
    expect(row?.failureReason).toContain('No live publisher');
    expect(row?.attemptCount).toBe(1);
  });

  it('is idempotent — re-running the executor on a finalized entry is a no-op', async () => {
    const entryId = await schedule(true);
    await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/calendar/${entryId}/publish`,
      headers: { cookie },
    });
    await executePublication({ prisma: prisma.client }, { entryId });
    const second = await executePublication({ prisma: prisma.client }, { entryId });
    expect(second.status).toBe('SKIPPED');
  });

  it('refuses publish-now without a target account (422)', async () => {
    const entryId = await schedule(false);
    const publish = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/calendar/${entryId}/publish`,
      headers: { cookie },
    });
    expect(publish.statusCode).toBe(422);
  });
});
