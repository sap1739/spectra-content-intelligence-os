import './setup-env';

import { randomBytes } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { executePublication, type ResolvePublisher } from '@spectra/publishing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Publishing pipeline (Phase 4B + 4D). Without a live publisher for the target
 * platform an attempt resolves to an honest UNSUPPORTED — never a fabricated
 * PUBLISHED. When a publisher IS resolved (Phase 4D wires a real WordPress
 * adapter in the worker), the same path persists a real PUBLISHED end-to-end.
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

describe('API integration: publishing pipeline', () => {
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

  it('publish-now queues a targeted entry', async () => {
    const entryId = await schedule(true);
    const publish = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/calendar/${entryId}/publish`,
      headers: { cookie },
    });
    expect(publish.statusCode).toBe(201);
    expect((publish.json() as { status: string }).status).toBe('QUEUED');
  });

  it('the executor records an honest UNSUPPORTED for an unwired platform', async () => {
    // Flip to QUEUED directly (as the dispatcher's claim does) so a running
    // worker isn't racing this entry via the queue. LINKEDIN has no adapter and
    // no resolver is supplied → honest UNSUPPORTED, never a fabricated success.
    const entryId = await schedule(true);
    await prisma.client.contentScheduleEntry.update({
      where: { id: entryId },
      data: { status: 'QUEUED' },
    });

    const outcome = await executePublication({ prisma: prisma.client }, { entryId });
    expect(outcome.status).toBe('UNSUPPORTED');

    const row = await prisma.client.contentScheduleEntry.findUnique({ where: { id: entryId } });
    expect(row?.status).toBe('UNSUPPORTED');
    expect(row?.failureReason).toContain('No live publisher');
    expect(row?.attemptCount).toBe(1);
  });

  it('persists a real PUBLISHED when a live publisher is resolved (WordPress path)', async () => {
    // A WordPress target with its own approved item, scheduled and queued.
    const wpItem = await prisma.client.contentItem.create({
      data: {
        organizationId: orgId,
        workspaceId,
        title: 'WP post',
        contentType: 'POST',
        lifecycleState: 'APPROVED',
        body: 'The body that gets published.',
      },
    });
    const wpAccount = await prisma.client.socialAccount.create({
      data: {
        organizationId: orgId,
        workspaceId,
        platform: 'WORDPRESS',
        externalAccountId: 'https://blog.example.com',
        displayName: 'Blog',
        status: 'PENDING',
      },
    });
    const scheduled = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/calendar`,
      headers: { cookie },
      payload: {
        contentItemId: wpItem.id,
        platform: 'WORDPRESS',
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
        socialAccountId: wpAccount.id,
      },
    });
    const wpEntryId = (scheduled.json() as { id: string }).id;
    // Flip to QUEUED directly (as the dispatcher's claim does) rather than via
    // publish-now — that would enqueue a real job a running worker could race
    // to UNSUPPORTED (no key configured there). Here we drive the executor
    // in-process with a resolved publisher.
    await prisma.client.contentScheduleEntry.update({
      where: { id: wpEntryId },
      data: { status: 'QUEUED' },
    });

    // Stub the network boundary only — everything else is the real executor + DB.
    let publishedTitle = '';
    let publishedBody = '';
    const resolvePublisher: ResolvePublisher = async (account) => {
      expect(account.platform).toBe('WORDPRESS');
      expect(account.externalAccountId).toBe('https://blog.example.com');
      return {
        platform: 'WORDPRESS',
        adapterVersion: 'stub-1',
        publish: async (payload) => {
          publishedTitle = payload.title;
          publishedBody = payload.body;
          return {
            status: 'PUBLISHED',
            externalPostId: 'wp-7',
            externalUrl: 'https://blog.example.com/?p=7',
            publishedAt: '2026-07-14T00:00:00.000Z',
          };
        },
      };
    };

    const outcome = await executePublication(
      { prisma: prisma.client, resolvePublisher },
      { entryId: wpEntryId },
    );
    expect(outcome.status).toBe('PUBLISHED');
    // The real item body flowed to the publisher.
    expect(publishedTitle).toBe('WP post');
    expect(publishedBody).toBe('The body that gets published.');

    const row = await prisma.client.contentScheduleEntry.findUnique({ where: { id: wpEntryId } });
    expect(row?.status).toBe('PUBLISHED');
    expect(row?.externalPostId).toBe('wp-7');
    expect(row?.externalUrl).toBe('https://blog.example.com/?p=7');
    expect(row?.publishedAt).toBeTruthy();
    // The content item lifecycle advanced to PUBLISHED.
    const item = await prisma.client.contentItem.findUnique({ where: { id: wpItem.id } });
    expect(item?.lifecycleState).toBe('PUBLISHED');
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
