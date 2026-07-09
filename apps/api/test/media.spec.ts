import './setup-env';

import { randomBytes } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';

/** Phase 3F: real sharp image rendering + honest video/audio unavailability. */

// A valid 1x1 PNG — sharp resizes it to the requested dimensions.
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const runId = randomBytes(4).toString('hex');
const ownerEmail = `media-${runId}@itest.local`;
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

describe('API integration: media rendering', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let cookie = '';
  let orgId = '';
  let ws = '';

  const inject = () => app.getHttpAdapter().getInstance();

  beforeAll(async () => {
    app = await createApp(getApiEnv());
    await app.init();
    await inject().ready();
    prisma = app.get(PrismaService);

    const register = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: ownerEmail, password: PASSWORD, name: 'Media Owner' },
    });
    cookie = cookieOf(register.headers['set-cookie']);
    const me = register.json() as MeBody;
    orgId = me.memberships[0]?.organizationId as string;
    ws = me.workspaces[0]?.id as string;
  }, 30_000);

  afterAll(async () => {
    if (orgId) {
      await prisma.client.mediaAsset
        .deleteMany({ where: { organizationId: orgId } })
        .catch(() => undefined);
      await prisma.client.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    }
    await prisma.client.user.delete({ where: { email: ownerEmail } }).catch(() => undefined);
    await app.close();
  });

  it('reports image available and video/audio honestly unavailable', async () => {
    const res = await inject().inject({
      method: 'GET',
      url: `/v1/workspaces/${ws}/media/status`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const status = res.json() as { image: boolean; video: boolean; audio: boolean };
    expect(status.image).toBe(true);
    expect(status.video).toBe(false);
    expect(status.audio).toBe(false);
  });

  it('processes an image and streams the derived bytes back', async () => {
    const processed = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${ws}/media/images`,
      headers: { cookie },
      payload: {
        imageBase64: PNG_1x1,
        operations: [{ kind: 'resize', width: 48, height: 24, fit: 'fill' }],
        outputFormat: 'webp',
      },
    });
    expect(processed.statusCode).toBe(201);
    const asset = processed.json() as {
      id: string;
      kind: string;
      mimeType: string;
      widthPx: number;
      heightPx: number;
      engine: string;
      storageKey: string;
    };
    expect(asset.kind).toBe('IMAGE');
    expect(asset.mimeType).toBe('image/webp');
    expect(asset.widthPx).toBe(48);
    expect(asset.heightPx).toBe(24);
    expect(asset.engine).toBe('sharp');
    // Derived asset is stored under the tenant-rooted renders domain.
    expect(asset.storageKey.startsWith(`org/${orgId}/ws/${ws}/renders/`)).toBe(true);

    // The bytes can be streamed back with the right content type.
    const content = await inject().inject({
      method: 'GET',
      url: `/v1/workspaces/${ws}/media/${asset.id}/content`,
      headers: { cookie },
    });
    expect(content.statusCode).toBe(200);
    expect(content.headers['content-type']).toContain('image/webp');
    expect(content.rawPayload.length).toBeGreaterThan(0);

    // Both source and derived assets are listed.
    const list = await inject().inject({
      method: 'GET',
      url: `/v1/workspaces/${ws}/media`,
      headers: { cookie },
    });
    expect((list.json() as unknown[]).length).toBe(2);
  });

  it('rejects a non-image payload with 422 (never a silent bad render)', async () => {
    const res = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${ws}/media/images`,
      headers: { cookie },
      payload: {
        imageBase64: Buffer.from('not an image').toString('base64'),
        operations: [{ kind: 'resize', width: 10, height: 10, fit: 'cover' }],
        outputFormat: 'png',
      },
    });
    expect(res.statusCode).toBe(422);
  });
});
