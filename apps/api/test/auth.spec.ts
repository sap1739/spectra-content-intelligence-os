import './setup-env';

import { randomBytes } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Full-stack auth + tenancy integration tests. Require Postgres and Redis
 * (docker compose locally; service containers in CI). Everything created here
 * is cleaned up in afterAll.
 */

interface MeBody {
  user: { id: string; email: string };
  memberships: Array<{ organizationId: string; role: string }>;
  workspaces: Array<{ id: string; organizationId: string; name: string }>;
}

const runId = randomBytes(4).toString('hex');
const emailA = `alice-${runId}@itest.local`;
const emailB = `bob-${runId}@itest.local`;
const PASSWORD = 'integration-test-password-1';

function cookieOf(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) throw new Error('expected a set-cookie header');
  return raw.split(';')[0] as string;
}

/** Problem bodies minus the per-request correlation id, for equality checks. */
function comparableProblem(body: unknown): Record<string, unknown> {
  const { correlationId: _cid, ...rest } = body as Record<string, unknown>;
  return rest;
}

describe('API integration: authentication & tenant isolation', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let cookieA = '';
  let cookieB = '';
  let meA: MeBody;
  let meB: MeBody;
  let verticalId = '';
  const createdUserIds: string[] = [];
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    app = await createApp(getApiEnv());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);

    // Sweep leftovers from previously interrupted runs.
    const staleUsers = await prisma.client.user.findMany({
      where: { email: { endsWith: '@itest.local' } },
      include: { memberships: true },
    });
    const staleOrgIds = [
      ...new Set(staleUsers.flatMap((u) => u.memberships.map((m) => m.organizationId))),
    ];
    for (const orgId of staleOrgIds) {
      await prisma.client.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    }
    for (const user of staleUsers) {
      await prisma.client.user.delete({ where: { id: user.id } }).catch(() => undefined);
    }
  });

  afterAll(async () => {
    // Best-effort cleanup — cascades remove memberships/workspaces/verticals.
    for (const orgId of createdOrgIds) {
      await prisma.client.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    }
    for (const userId of createdUserIds) {
      await prisma.client.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
    await app.close();
  });

  const inject = () => app.getHttpAdapter().getInstance();

  it('registers a user with a bootstrap organization and workspace', async () => {
    const response = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: emailA, password: PASSWORD, name: 'Alice Tester' },
    });
    expect(response.statusCode).toBe(201);
    cookieA = cookieOf(response.headers['set-cookie']);
    meA = response.json() as MeBody;
    createdUserIds.push(meA.user.id);
    createdOrgIds.push(...meA.memberships.map((m) => m.organizationId));

    expect(meA.memberships[0]?.role).toBe('ORG_OWNER');
    expect(meA.workspaces.length).toBe(1);
    expect(meA.workspaces[0]?.name).toBe('General');
  });

  it('rejects duplicate registration with 409', async () => {
    const response = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: emailA, password: PASSWORD, name: 'Alice Again' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('rejects weak passwords with field-level validation errors', async () => {
    const response = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `weak-${runId}@itest.local`, password: 'short', name: 'Weak' },
    });
    expect(response.statusCode).toBe(422);
    const body = response.json() as { errors: Array<{ path: string }> };
    expect(body.errors.some((e) => e.path === 'password')).toBe(true);
  });

  it('requires authentication for protected routes', async () => {
    const response = await inject().inject({ method: 'GET', url: '/v1/auth/me' });
    expect(response.statusCode).toBe(401);
  });

  it('logs in with correct credentials and rejects wrong ones identically', async () => {
    const ok = await inject().inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: emailA, password: PASSWORD },
    });
    expect(ok.statusCode).toBe(200);
    cookieA = cookieOf(ok.headers['set-cookie']);

    const wrongPassword = await inject().inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: emailA, password: 'definitely-wrong-password' },
    });
    const unknownEmail = await inject().inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: `nobody-${runId}@itest.local`, password: PASSWORD },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    // No user enumeration: identical bodies (correlation id aside).
    expect(comparableProblem(wrongPassword.json())).toEqual(comparableProblem(unknownEmail.json()));
  });

  it('creates and lists verticals in the caller workspace', async () => {
    const workspaceId = meA.workspaces[0]?.id as string;
    const created = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/verticals`,
      headers: { cookie: cookieA },
      payload: {
        name: 'Hyderabad real estate',
        industry: 'Real estate',
        keywords: ['hyderabad', 'real estate'],
        geographies: ['Hyderabad, India'],
        languages: ['en', 'te'],
      },
    });
    expect(created.statusCode).toBe(201);
    const vertical = created.json() as { id: string; slug: string; status: string };
    verticalId = vertical.id;
    expect(vertical.slug).toBe('hyderabad-real-estate');
    expect(vertical.status).toBe('ACTIVE');

    const list = await inject().inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/verticals`,
      headers: { cookie: cookieA },
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as unknown[]).length).toBe(1);
  });

  it('isolates tenants: another user gets identical 404s for foreign and missing resources', async () => {
    const registerB = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: emailB, password: PASSWORD, name: 'Bob Outsider' },
    });
    expect(registerB.statusCode).toBe(201);
    cookieB = cookieOf(registerB.headers['set-cookie']);
    meB = registerB.json() as MeBody;
    createdUserIds.push(meB.user.id);
    createdOrgIds.push(...meB.memberships.map((m) => m.organizationId));

    const workspaceA = meA.workspaces[0]?.id as string;

    const foreignList = await inject().inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceA}/verticals`,
      headers: { cookie: cookieB },
    });
    expect(foreignList.statusCode).toBe(404);

    const foreignGet = await inject().inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceA}/verticals/${verticalId}`,
      headers: { cookie: cookieB },
    });
    const missingGet = await inject().inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceA}/verticals/00000000-0000-4000-8000-0000000000ff`,
      headers: { cookie: cookieB },
    });
    expect(foreignGet.statusCode).toBe(404);
    expect(missingGet.statusCode).toBe(404);
    // Existence must not be inferable from the response body.
    expect(comparableProblem(foreignGet.json())).toEqual(comparableProblem(missingGet.json()));
  });

  it('enforces permissions: READ_ONLY members can read but not write', async () => {
    const orgA = meA.memberships[0]?.organizationId as string;
    const workspaceA = meA.workspaces[0]?.id as string;

    await prisma.client.membership.create({
      data: {
        organizationId: orgA,
        userId: meB.user.id,
        role: 'READ_ONLY',
        status: 'ACTIVE',
      },
    });

    const read = await inject().inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceA}/verticals`,
      headers: { cookie: cookieB },
    });
    expect(read.statusCode).toBe(200);

    const write = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceA}/verticals`,
      headers: { cookie: cookieB },
      payload: { name: 'Should be denied' },
    });
    expect(write.statusCode).toBe(403);
    const problem = write.json() as { title?: string; detail?: string };
    expect(`${problem.title ?? ''} ${problem.detail ?? ''}`).toContain('vertical:write');
  });

  it('blocks cross-site origins on mutations (CSRF origin check)', async () => {
    const workspaceA = meA.workspaces[0]?.id as string;
    const response = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceA}/verticals`,
      headers: { cookie: cookieA, origin: 'https://evil.example.com' },
      payload: { name: 'CSRF attempt' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('supports research project CRUD with tenant-checked references', async () => {
    const workspaceA = meA.workspaces[0]?.id as string;
    const created = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceA}/research-projects`,
      headers: { cookie: cookieA },
      payload: {
        name: 'Landscape scan',
        objective: 'Track AI-powered QA developments in India and globally.',
        verticalId,
      },
    });
    expect(created.statusCode).toBe(201);
    const project = created.json() as { id: string; status: string; verticalId: string };
    expect(project.status).toBe('DRAFT');
    expect(project.verticalId).toBe(verticalId);

    // Referencing a foreign/nonexistent vertical fails as not-found.
    const badRef = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceA}/research-projects`,
      headers: { cookie: cookieA },
      payload: { name: 'Bad ref', verticalId: '00000000-0000-4000-8000-0000000000aa' },
    });
    expect(badRef.statusCode).toBe(404);
  });

  it('logout destroys the session', async () => {
    const logout = await inject().inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: cookieA },
    });
    expect(logout.statusCode).toBe(204);

    const me = await inject().inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: cookieA },
    });
    expect(me.statusCode).toBe(401);
  });
});
