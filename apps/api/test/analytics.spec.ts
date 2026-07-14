import './setup-env';

import { randomBytes } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';

/** Phase 4C analytics — real first-party counts, no fabricated engagement. */

const runId = randomBytes(4).toString('hex');
const ownerEmail = `analytics-owner-${runId}@itest.local`;
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

describe('API integration: analytics overview', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let cookie = '';
  let orgId = '';
  let workspaceId = '';

  const inject = () => app.getHttpAdapter().getInstance();

  beforeAll(async () => {
    app = await createApp(getApiEnv());
    await app.init();
    await inject().ready();
    prisma = app.get(PrismaService);

    const register = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: ownerEmail, password: PASSWORD, name: 'Analytics Owner' },
    });
    cookie = cookieOf(register.headers['set-cookie']);
    const me = register.json() as MeBody;
    orgId = me.memberships[0]?.organizationId as string;
    workspaceId = me.workspaces[0]?.id as string;

    // Seed real, countable data: two items (one PUBLISHED) + a READY draft.
    const published = await prisma.client.contentItem.create({
      data: {
        organizationId: orgId,
        workspaceId,
        title: 'A',
        contentType: 'POST',
        lifecycleState: 'PUBLISHED',
      },
    });
    await prisma.client.contentItem.create({
      data: {
        organizationId: orgId,
        workspaceId,
        title: 'B',
        contentType: 'POST',
        lifecycleState: 'DRAFT',
      },
    });
    await prisma.client.contentDraft.create({
      data: { organizationId: orgId, workspaceId, contentItemId: published.id, status: 'READY' },
    });
  });

  afterAll(async () => {
    await prisma.client.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    await prisma.client.user.delete({ where: { email: ownerEmail } }).catch(() => undefined);
    await app.close();
  });

  it('returns real workspace counts and honest engagement unavailability', async () => {
    const res = await inject().inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/analytics/overview`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      content: { total: number; published: number; byLifecycleState: Record<string, number> };
      drafts: { total: number };
      engagement: { externalAvailable: boolean; note: string };
    };
    expect(body.content.total).toBe(2);
    expect(body.content.published).toBe(1);
    expect(body.content.byLifecycleState.DRAFT).toBe(1);
    expect(body.drafts.total).toBe(1);
    // Honest: no external engagement, and it says so — never a fabricated number.
    expect(body.engagement.externalAvailable).toBe(false);
    expect(body.engagement.note).toContain('unavailable');
  });

  it('scopes to the tenant — a fresh workspace reports zeros', async () => {
    // Second org/workspace via a new registration.
    const other = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `other-${runId}@itest.local`, password: PASSWORD, name: 'Other' },
    });
    const otherCookie = cookieOf(other.headers['set-cookie']);
    const otherWs = (other.json() as MeBody).workspaces[0]?.id as string;
    const otherOrg = (other.json() as MeBody).memberships[0]?.organizationId as string;

    const res = await inject().inject({
      method: 'GET',
      url: `/v1/workspaces/${otherWs}/analytics/overview`,
      headers: { cookie: otherCookie },
    });
    expect((res.json() as { content: { total: number } }).content.total).toBe(0);

    await prisma.client.organization.delete({ where: { id: otherOrg } }).catch(() => undefined);
    await prisma.client.user
      .delete({ where: { email: `other-${runId}@itest.local` } })
      .catch(() => undefined);
  });
});
