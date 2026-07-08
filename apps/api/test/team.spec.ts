import './setup-env';

import { randomBytes } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';

/** Phase 2 close-out flows: invitations, login throttling, watchlists. */

const runId = randomBytes(4).toString('hex');
const ownerEmail = `owner-${runId}@itest.local`;
const inviteeEmail = `invitee-${runId}@itest.local`;
const throttledEmail = `throttled-${runId}@itest.local`;
const PASSWORD = 'integration-test-password-1';

interface MeBody {
  user: { id: string };
  memberships: Array<{ organizationId: string; role: string }>;
  workspaces: Array<{ id: string; organizationId: string }>;
}

function cookieOf(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) throw new Error('expected a set-cookie header');
  return raw.split(';')[0] as string;
}

describe('API integration: team, invitations, throttling, watchlists', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let ownerCookie = '';
  let ownerOrgId = '';
  let ownerWorkspaceId = '';
  const createdUserIds: string[] = [];
  const createdOrgIds: string[] = [];

  const inject = () => app.getHttpAdapter().getInstance();

  beforeAll(async () => {
    app = await createApp(getApiEnv());
    await app.init();
    await inject().ready();
    prisma = app.get(PrismaService);

    const register = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: ownerEmail, password: PASSWORD, name: 'Team Owner' },
    });
    expect(register.statusCode).toBe(201);
    ownerCookie = cookieOf(register.headers['set-cookie']);
    const me = register.json() as MeBody;
    ownerOrgId = me.memberships[0]?.organizationId as string;
    ownerWorkspaceId = me.workspaces[0]?.id as string;
    createdUserIds.push(me.user.id);
    createdOrgIds.push(ownerOrgId);
  });

  afterAll(async () => {
    for (const orgId of createdOrgIds) {
      await prisma.client.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    }
    for (const userId of createdUserIds) {
      await prisma.client.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
    await app.close();
  });

  it('invites an email; registering with it joins the organization with the invited role', async () => {
    const invite = await inject().inject({
      method: 'POST',
      url: `/v1/organizations/${ownerOrgId}/invitations`,
      headers: { cookie: ownerCookie },
      payload: { email: inviteeEmail, role: 'RESEARCHER' },
    });
    expect(invite.statusCode).toBe(201);
    expect((invite.json() as { token: string }).token).toBeTruthy();

    const pending = await inject().inject({
      method: 'GET',
      url: `/v1/organizations/${ownerOrgId}/invitations`,
      headers: { cookie: ownerCookie },
    });
    expect((pending.json() as unknown[]).length).toBe(1);

    // Invitee registers → personal org + auto-joined invited org.
    const register = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: inviteeEmail, password: PASSWORD, name: 'Invited Researcher' },
    });
    expect(register.statusCode).toBe(201);
    const me = register.json() as MeBody;
    createdUserIds.push(me.user.id);
    createdOrgIds.push(
      ...me.memberships.map((m) => m.organizationId).filter((id) => id !== ownerOrgId),
    );
    const joined = me.memberships.find((m) => m.organizationId === ownerOrgId);
    expect(joined?.role).toBe('RESEARCHER');

    // Members list shows both; invitation no longer pending.
    const members = await inject().inject({
      method: 'GET',
      url: `/v1/organizations/${ownerOrgId}/members`,
      headers: { cookie: ownerCookie },
    });
    expect((members.json() as unknown[]).length).toBe(2);
    const pendingAfter = await inject().inject({
      method: 'GET',
      url: `/v1/organizations/${ownerOrgId}/invitations`,
      headers: { cookie: ownerCookie },
    });
    expect((pendingAfter.json() as unknown[]).length).toBe(0);
  });

  it('non-admin members cannot manage invitations', async () => {
    const login = await inject().inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: inviteeEmail, password: PASSWORD },
    });
    const inviteeCookie = cookieOf(login.headers['set-cookie']);
    const attempt = await inject().inject({
      method: 'POST',
      url: `/v1/organizations/${ownerOrgId}/invitations`,
      headers: { cookie: inviteeCookie },
      payload: { email: `nope-${runId}@itest.local`, role: 'READ_ONLY' },
    });
    expect(attempt.statusCode).toBe(403);
  });

  it('throttles repeated failed logins per email+IP with 429', async () => {
    // Account exists so the throttle path (not enumeration) is what's tested.
    const register = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: throttledEmail, password: PASSWORD, name: 'Throttle Target' },
    });
    const me = register.json() as MeBody;
    createdUserIds.push(me.user.id);
    createdOrgIds.push(...me.memberships.map((m) => m.organizationId));

    for (let i = 0; i < 5; i += 1) {
      const attempt = await inject().inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: throttledEmail, password: 'wrong-password-attempt' },
      });
      expect(attempt.statusCode).toBe(401);
    }
    const blocked = await inject().inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: throttledEmail, password: PASSWORD }, // even correct now
    });
    expect(blocked.statusCode).toBe(429);
  });

  it('supports watchlist CRUD with tenant scoping', async () => {
    const created = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${ownerWorkspaceId}/watchlists`,
      headers: { cookie: ownerCookie },
      payload: { name: 'AI watch', keywords: ['AI testing'], threshold: 0.5 },
    });
    expect(created.statusCode).toBe(201);
    const watchlist = created.json() as { id: string; threshold: number };
    expect(watchlist.threshold).toBe(0.5);

    const list = await inject().inject({
      method: 'GET',
      url: `/v1/workspaces/${ownerWorkspaceId}/watchlists`,
      headers: { cookie: ownerCookie },
    });
    expect((list.json() as unknown[]).length).toBe(1);

    const removed = await inject().inject({
      method: 'DELETE',
      url: `/v1/workspaces/${ownerWorkspaceId}/watchlists/${watchlist.id}`,
      headers: { cookie: ownerCookie },
    });
    expect(removed.statusCode).toBe(204);
  });

  it('sets and clears a recurring research schedule', async () => {
    const project = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${ownerWorkspaceId}/research-projects`,
      headers: { cookie: ownerCookie },
      payload: { name: 'Schedule test project' },
    });
    const projectId = (project.json() as { id: string }).id;

    const set = await inject().inject({
      method: 'PUT',
      url: `/v1/workspaces/${ownerWorkspaceId}/research-projects/${projectId}/runs/schedule`,
      headers: { cookie: ownerCookie },
      payload: { everyMinutes: 60, feedUrls: ['https://example.com/feed.xml'] },
    });
    expect(set.statusCode).toBe(200);
    expect((set.json() as { scheduleEveryMinutes: number }).scheduleEveryMinutes).toBe(60);

    const cleared = await inject().inject({
      method: 'DELETE',
      url: `/v1/workspaces/${ownerWorkspaceId}/research-projects/${projectId}/runs/schedule`,
      headers: { cookie: ownerCookie },
    });
    expect(cleared.statusCode).toBe(200);
    expect((cleared.json() as { scheduleEveryMinutes: null }).scheduleEveryMinutes).toBeNull();
  });
});
