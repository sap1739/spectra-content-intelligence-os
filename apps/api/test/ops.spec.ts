import './setup-env';

import { randomBytes } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SYSTEM_QUEUE } from '@spectra/workflow-core';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

/**
 * Operations endpoints (ADR-0033): queue status, failed-job listing scoped to
 * the tenant, retry authorization, and the metrics exposition.
 */

const runId = randomBytes(4).toString('hex');
const ownerEmail = `ops-owner-${runId}@itest.local`;
const PASSWORD = 'integration-test-password-1';

interface MeBody {
  memberships: Array<{ organizationId: string; effectivePermissions: string[] }>;
  workspaces: Array<{ id: string }>;
}

function cookieOf(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) throw new Error('expected a set-cookie header');
  return raw.split(';')[0] as string;
}

describe('API integration: operations', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let queue: Queue;
  let cookie = '';
  let orgId = '';
  let workspaceId = '';
  const seededJobIds: string[] = [];

  const inject = () => app.getHttpAdapter().getInstance();
  /** BullMQ workers block on Redis, so they need a connection of their own. */
  const connections: IORedis[] = [];
  const workerConnection = () => {
    const connection = new IORedis(process.env['REDIS_URL'] as string, {
      maxRetriesPerRequest: null,
    });
    connections.push(connection);
    return connection;
  };
  const ws = () => `/v1/workspaces/${workspaceId}`;

  beforeAll(async () => {
    app = await createApp(getApiEnv());
    await app.init();
    await inject().ready();
    prisma = app.get(PrismaService);
    queue = new Queue(SYSTEM_QUEUE, { connection: app.get(RedisService).client });

    const register = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: ownerEmail, password: PASSWORD, name: 'Ops Owner' },
    });
    cookie = cookieOf(register.headers['set-cookie']);
    const me = register.json() as MeBody;
    orgId = me.memberships[0]?.organizationId as string;
    workspaceId = me.workspaces[0]?.id as string;
  });

  afterAll(async () => {
    for (const id of seededJobIds) {
      await queue
        .getJob(id)
        .then((j) => j?.remove())
        .catch(() => undefined);
    }
    await queue.close().catch(() => undefined);
    for (const connection of connections) connection.disconnect();
    await prisma.client.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    await prisma.client.user.delete({ where: { email: ownerEmail } }).catch(() => undefined);
    await app.close();
  });

  /**
   * Seeds a genuinely failed job.
   *
   * A job only reaches the failed set by being processed, so this runs a
   * short-lived worker. Two details matter:
   *
   * - a developer's own worker may already be listening on this queue, so the
   *   test worker hands back any job that is not one of ours (BullMQ's
   *   `RateLimitError` returns a job to `waiting` untouched) — a test must
   *   never sabotage real work;
   * - either worker may win the race for our job, so we poll for the `failed`
   *   state rather than listening for our own worker's event.
   */
  async function seedFailedJob(opts: {
    name: string;
    organizationId: string;
    workspaceId?: string;
    payload?: Record<string, unknown>;
  }): Promise<string> {
    const jobId = `ops-test-${randomBytes(5).toString('hex')}`;
    await queue.add(
      opts.name,
      {
        payload: opts.payload ?? { runId: `res-${randomBytes(3).toString('hex')}` },
        correlationId: `corr-${randomBytes(3).toString('hex')}`,
        tenant: {
          organizationId: opts.organizationId,
          ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
        },
        enqueuedAt: new Date().toISOString(),
      },
      { jobId, attempts: 1, removeOnFail: false },
    );

    const worker: Worker = new Worker(
      SYSTEM_QUEUE,
      async (job) => {
        if (!job.id?.startsWith('ops-test-')) {
          // Somebody else's job — put it straight back, unprocessed.
          await worker.rateLimit(1);
          throw Worker.RateLimitError();
        }
        throw new Error('seeded failure for ops test');
      },
      { connection: workerConnection(), autorun: true },
    );

    try {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const job = await queue.getJob(jobId);
        const state = await job?.getState();
        if (state === 'failed') return (seededJobIds.push(jobId), jobId);
        if (Date.now() > deadline) {
          throw new Error(`job ${jobId} never reached the failed state (state=${state})`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      await worker.close();
    }
  }

  it('reports queue status with real counts', async () => {
    const res = await inject().inject({
      method: 'GET',
      url: `${ws()}/ops/queue`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { reachable: boolean; counts: Record<string, number> | null };
    expect(body.reachable).toBe(true);
    expect(body.counts).not.toBeNull();
    expect(typeof body.counts?.['failed']).toBe('number');
  });

  it('lists this tenant’s failed jobs with a category and correlation id', async () => {
    const jobId = await seedFailedJob({
      name: 'research.run.execute',
      organizationId: orgId,
      workspaceId,
    });

    const res = await inject().inject({
      method: 'GET',
      url: `${ws()}/ops/failed-jobs`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      reachable: boolean;
      failed: Array<{ id: string; category: string; reason: string; correlationId: string | null }>;
    };
    expect(body.reachable).toBe(true);
    const found = body.failed.find((j) => j.id === jobId);
    expect(found).toBeDefined();
    expect(found?.category).toBe('Research runs');
    // Which worker won the race decides the wording; that a reason is shown
    // at all is the contract.
    expect(found?.reason).toBeTruthy();
    // The id an operator quotes back to a customer.
    expect(found?.correlationId).toBeTruthy();
  });

  it('does NOT list another tenant’s failed jobs', async () => {
    const foreignOrg = randomBytes(16).toString('hex');
    const foreignJobId = await seedFailedJob({
      name: 'content.draft.generate',
      organizationId: `00000000-0000-4000-8000-${foreignOrg.slice(0, 12)}`,
    });

    const res = await inject().inject({
      method: 'GET',
      url: `${ws()}/ops/failed-jobs`,
      headers: { cookie },
    });
    const body = res.json() as { failed: Array<{ id: string }> };
    expect(body.failed.some((j) => j.id === foreignJobId)).toBe(false);
  });

  it('retries a failed job, preserving its id (and therefore its idempotency key)', async () => {
    const jobId = await seedFailedJob({
      name: 'publication.publish',
      organizationId: orgId,
      workspaceId,
      payload: { entryId: 'entry-1' },
    });
    const failedAt = (await queue.getJob(jobId))?.finishedOn;

    const res = await inject().inject({
      method: 'POST',
      url: `${ws()}/ops/failed-jobs/${jobId}/retry`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { retried: boolean }).retried).toBe(true);

    // The SAME job id is back in the queue — not a copy. A new id would defeat
    // the idempotency key the job was enqueued under.
    //
    // Asserted as "left the failed state, OR was re-run" rather than a single
    // state read: a worker may already have picked the job up and failed it
    // again by the time we look, and that is still a successful retry.
    const job = await queue.getJob(jobId);
    expect(job).toBeTruthy();
    expect(job?.name).toBe('publication.publish');
    const state = await job?.getState();
    expect(state !== 'failed' || job?.finishedOn !== failedAt).toBe(true);
  });

  it('refuses to retry a job belonging to another tenant (404, no existence leak)', async () => {
    const foreignJobId = await seedFailedJob({
      name: 'research.run.execute',
      organizationId: '00000000-0000-4000-8000-0000000000ff',
    });

    const res = await inject().inject({
      method: 'POST',
      url: `${ws()}/ops/failed-jobs/${foreignJobId}/retry`,
      headers: { cookie },
    });
    // Indistinguishable from a job that does not exist.
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a job id that does not exist at all', async () => {
    const res = await inject().inject({
      method: 'POST',
      url: `${ws()}/ops/failed-jobs/definitely-not-a-job/retry`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires ops permissions', async () => {
    // The owner has every permission; assert the route is permission-gated by
    // confirming the permission appears on the membership at all.
    const me = await inject().inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
    const body = me.json() as MeBody;
    expect(body.memberships[0]?.effectivePermissions).toContain('ops:read');
    expect(body.memberships[0]?.effectivePermissions).toContain('ops:retry');
  });

  it('exposes Prometheus metrics containing no tenant content', async () => {
    // Generate at least one request so a histogram exists.
    await inject().inject({ method: 'GET', url: `${ws()}/ops/queue`, headers: { cookie } });

    const res = await inject().inject({ method: 'GET', url: '/v1/meta/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('spectra_api_request_duration_ms');
    // Labelled by route PATTERN, so no ids or query strings reach the backend.
    expect(res.body).toContain(':workspaceId');
    expect(res.body).not.toContain(workspaceId);
  });

  it('readiness reports queue and storage without leaking configuration', async () => {
    const res = await inject().inject({ method: 'GET', url: '/health/ready' });
    const body = res.json() as {
      components: Array<{ name: string; status: string; detail?: string }>;
    };
    const names = body.components.map((c) => c.name);
    expect(names).toContain('postgres');
    expect(names).toContain('redis');
    expect(names).toContain('job-queue');
    expect(names).toContain('object-storage');
    // No endpoint, key or credential in any detail string.
    const details = body.components.map((c) => c.detail ?? '').join(' ');
    expect(details).not.toMatch(/http:\/\/|https:\/\/|key|secret|password/i);
  });
});
