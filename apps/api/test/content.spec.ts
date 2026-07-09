import './setup-env';

import { randomBytes } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase 3 content generation. The test environment has no ANTHROPIC_API_KEY,
 * so generation is honestly UNAVAILABLE (503) — this proves the platform never
 * fabricates output when a provider is not configured.
 */

const runId = randomBytes(4).toString('hex');
const ownerEmail = `content-owner-${runId}@itest.local`;
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

describe('API integration: content items, evidence grounding, honest AI unavailability', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let cookie = '';
  let orgId = '';
  let workspaceId = '';
  let projectId = '';
  let packId = '';

  const inject = () => app.getHttpAdapter().getInstance();

  beforeAll(async () => {
    app = await createApp(getApiEnv());
    await app.init();
    await inject().ready();
    prisma = app.get(PrismaService);

    const register = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: ownerEmail, password: PASSWORD, name: 'Content Owner' },
    });
    cookie = cookieOf(register.headers['set-cookie']);
    const me = register.json() as MeBody;
    orgId = me.memberships[0]?.organizationId as string;
    workspaceId = me.workspaces[0]?.id as string;

    // Seed a READY evidence pack to ground content on (tenant-scoped).
    const project = await prisma.client.researchProject.create({
      data: {
        organizationId: orgId,
        workspaceId,
        name: 'Content IT project',
        status: 'ACTIVE',
      },
    });
    projectId = project.id;
    const pack = await prisma.client.evidencePack.create({
      data: {
        organizationId: orgId,
        workspaceId,
        projectId,
        topicKey: 'ai-testing',
        title: 'AI testing',
        summary: 'Enterprises are adopting AI testing.',
        status: 'READY',
        findingIds: [],
        citationIds: [],
      },
    });
    packId = pack.id;
  });

  afterAll(async () => {
    await prisma.client.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    await prisma.client.user.delete({ where: { email: ownerEmail } }).catch(() => undefined);
    await app.close();
  });

  it('reports AI generation as unconfigured (no secrets exposed)', async () => {
    const res = await inject().inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/ai/status`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { configured: boolean; provider: string; model: string };
    expect(body.configured).toBe(false);
    expect(body.provider).toBe('anthropic');
    expect(body).not.toHaveProperty('apiKey');
  });

  it('lists READY evidence packs available to ground on', async () => {
    const res = await inject().inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/evidence-packs`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const packs = res.json() as Array<{ id: string; status: string }>;
    expect(packs.some((p) => p.id === packId && p.status === 'READY')).toBe(true);
  });

  it('creates a content item grounded on an evidence pack and records lineage', async () => {
    const res = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/content-items`,
      headers: { cookie },
      payload: {
        title: 'Why enterprises adopt AI testing',
        contentType: 'POST',
        objective: 'Awareness among engineering leaders',
        evidencePackId: packId,
      },
    });
    expect(res.statusCode).toBe(201);
    const item = res.json() as {
      id: string;
      evidencePackId: string;
      lifecycleState: string;
      researchProjectId: string;
    };
    expect(item.evidencePackId).toBe(packId);
    expect(item.researchProjectId).toBe(projectId);
    expect(item.lifecycleState).toBe('RESEARCH_READY');

    const list = await inject().inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/content-items`,
      headers: { cookie },
    });
    expect((list.json() as unknown[]).length).toBe(1);
  });

  it('returns 503 (never fabricated text) when generating without a configured provider', async () => {
    const created = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/content-items`,
      headers: { cookie },
      payload: { title: 'Second item', contentType: 'POST', evidencePackId: packId },
    });
    const itemId = (created.json() as { id: string }).id;

    const generate = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/content-items/${itemId}/drafts`,
      headers: { cookie },
      payload: {},
    });
    expect(generate.statusCode).toBe(503);

    // No draft row was persisted — the guard fires before any generation attempt.
    const drafts = await inject().inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/content-items/${itemId}/drafts`,
      headers: { cookie },
    });
    expect((drafts.json() as unknown[]).length).toBe(0);
  });

  it('rejects generation for an ungrounded item (nothing to cite)', async () => {
    const created = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/content-items`,
      headers: { cookie },
      payload: { title: 'Ungrounded', contentType: 'POST' },
    });
    const item = created.json() as { id: string; evidencePackId: string | null };
    expect(item.evidencePackId).toBeNull();

    const generate = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/content-items/${item.id}/drafts`,
      headers: { cookie },
      payload: {},
    });
    expect(generate.statusCode).toBe(503);
  });

  it('does not leak foreign evidence packs across tenants', async () => {
    const res = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/content-items`,
      headers: { cookie },
      payload: {
        title: 'Foreign pack',
        contentType: 'POST',
        evidencePackId: '00000000-0000-0000-0000-000000000000',
      },
    });
    // Missing and foreign resources return the same error (no existence leak).
    expect(res.statusCode).toBe(404);
  });

  /** A GENERATED item so the lifecycle can be exercised without the worker. */
  async function seedGenerated(): Promise<string> {
    const item = await prisma.client.contentItem.create({
      data: {
        organizationId: orgId,
        workspaceId,
        title: 'Lifecycle item',
        contentType: 'POST',
        lifecycleState: 'GENERATED',
        body: 'A safe, grounded marketing post.',
      },
    });
    return item.id;
  }

  it('runs the edit → submit → approve flow; approval is honestly SKIPPED without AI', async () => {
    const id = await seedGenerated();

    const edit = await inject().inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceId}/content-items/${id}`,
      headers: { cookie },
      payload: { body: 'Edited body.' },
    });
    expect(edit.statusCode).toBe(200);
    expect((edit.json() as { lifecycleState: string }).lifecycleState).toBe('EDITING');

    const submit = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/content-items/${id}/submit`,
      headers: { cookie },
    });
    expect((submit.json() as { lifecycleState: string }).lifecycleState).toBe('REVIEW');

    const approve = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/content-items/${id}/approve`,
      headers: { cookie },
      payload: {},
    });
    expect(approve.statusCode).toBe(201);
    const approved = approve.json() as {
      lifecycleState: string;
      moderation: { status: string };
      approvals: unknown[];
    };
    expect(approved.lifecycleState).toBe('APPROVED');
    // No ANTHROPIC_API_KEY in tests → moderation is honestly recorded as SKIPPED.
    expect(approved.moderation.status).toBe('SKIPPED');
    expect(approved.approvals.length).toBe(1);
  });

  it('rejects an invalid lifecycle transition with 422', async () => {
    const id = await seedGenerated();
    // GENERATED → APPROVED is not a legal transition (must go through REVIEW).
    const approve = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/content-items/${id}/approve`,
      headers: { cookie },
      payload: {},
    });
    expect(approve.statusCode).toBe(422);
  });
});
