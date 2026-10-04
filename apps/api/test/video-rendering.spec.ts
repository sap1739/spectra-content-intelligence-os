import './setup-env';

import { randomBytes, randomUUID } from 'node:crypto';

import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FfmpegVideoRenderer, resolveFontFile } from '@spectra/media-ffmpeg';
import { S3ObjectStorageProvider, buildObjectKey } from '@spectra/storage';
import { executeVideoRender } from '@spectra/video-pipeline';
import { SYSTEM_QUEUE, createRedisConnection } from '@spectra/workflow-core';
import { Queue } from 'bullmq';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv } from '../src/config/env';
import { QueueService } from '../src/infra/queue.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase 7B: video rendering (ADR-0041), end to end against the real API,
 * Postgres, MinIO and a real ffmpeg. Every claim about a video is made by
 * decoding the bytes object storage holds — container, codec, dimensions,
 * duration — never by trusting a response field.
 *
 * Renders run in the worker. These tests call the same `executeVideoRender`
 * the worker calls, so the job body under test is the production one.
 */

const runId = randomBytes(4).toString('hex');
const PASSWORD = 'integration-test-password-1';

interface Tenant {
  email: string;
  cookie: string;
  userId: string;
  orgId: string;
  workspaceId: string;
}

interface RenderBody {
  id: string;
  status: string;
  formatKey: string;
  progressPercent: number;
  plannedDurationMs: number;
  failureReason: string | null;
  mediaAssetId: string | null;
  captionAssetId: string | null;
  thumbnailAssetId: string | null;
  warnings: string[];
  durationMs: number | null;
  widthPx: number | null;
  heightPx: number | null;
}

function problemText(body: unknown): string {
  const problem = body as { title?: string; detail?: string };
  return `${problem.title ?? ''} ${problem.detail ?? ''}`;
}

/** An MP4 begins with a box-size word and the `ftyp` box type. */
function isMp4(bytes: Buffer): boolean {
  return bytes.length > 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp';
}

describe('API integration: video rendering (ADR-0041)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let storage: S3ObjectStorageProvider;
  const tenants: Tenant[] = [];
  const storedKeys: string[] = [];
  let owner: Tenant;
  let other: Tenant;
  let photoId = '';
  let queueService: QueueService;
  let enqueueSpy: { mockRestore: () => void } | null = null;

  const inject = () => app.getHttpAdapter().getInstance();
  const video = (t: Tenant = owner) => `/v1/workspaces/${t.workspaceId}/video`;
  const get = (t: Tenant, url: string) =>
    inject().inject({ method: 'GET', url, headers: { cookie: t.cookie } });
  const send = (t: Tenant, method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    inject().inject({
      method,
      url,
      headers: { cookie: t.cookie },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  /**
   * Starts a render.
   *
   * The queue is stubbed for most of this suite. Enqueuing for real would put
   * jobs in the shared dev queue that no worker here consumes, and `ops.spec`
   * runs a BullMQ worker that waits for its own job — foreign jobs starve it,
   * and removing them mid-flight races its lock. One test below restores the
   * real queue to prove the production path enqueues; everything else drives
   * `executeVideoRender` directly, which is the body the worker runs anyway.
   */
  async function postRender(t: Tenant, projectId: string, payload: Record<string, unknown>) {
    return send(t, 'POST', `${video(t)}/projects/${projectId}/renders`, payload);
  }

  const renderer = () =>
    new FfmpegVideoRenderer({
      ffmpegPath: ffmpegInstaller.path,
      ffprobePath: ffprobeInstaller.path,
      fontFile: resolveFontFile(),
      timeoutMs: 120_000,
    });

  /** Runs the queued render exactly as the worker does. */
  async function runRender(renderId: string, signal?: AbortSignal) {
    return executeVideoRender(
      { prisma: prisma.client, storage, renderer: renderer() },
      renderId,
      signal ? { signal } : {},
    );
  }

  async function registerTenant(label: string): Promise<Tenant> {
    const email = `video-${label}-${runId}@itest.local`;
    const res = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD, name: `Video ${label}` },
    });
    const raw = res.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0] as string;
    const me = res.json() as {
      user: { id: string };
      memberships: Array<{ organizationId: string }>;
      workspaces: Array<{ id: string }>;
    };
    const tenant = {
      email,
      cookie,
      userId: me.user.id,
      orgId: me.memberships[0]?.organizationId as string,
      workspaceId: me.workspaces[0]?.id as string,
    };
    tenants.push(tenant);
    return tenant;
  }

  async function storeAsset(t: Tenant, bytes: Buffer, mimeType: string, filename: string) {
    const id = randomUUID();
    const key = buildObjectKey({
      organizationId: t.orgId,
      workspaceId: t.workspaceId,
      domain: 'media',
      resourceId: id,
      filename,
    });
    await storage.putObject({ key, body: bytes, contentType: mimeType });
    storedKeys.push(key);
    await prisma.client.mediaAsset.create({
      data: {
        id,
        organizationId: t.orgId,
        workspaceId: t.workspaceId,
        kind: mimeType.startsWith('image/') ? 'IMAGE' : 'OTHER',
        storageKey: key,
        mimeType,
        sizeBytes: bytes.length,
      },
    });
    return id;
  }

  function storyboard(overrides: Record<string, unknown> = {}) {
    return {
      scenes: [
        {
          id: 'one',
          durationMs: 1000,
          background: { kind: 'COLOR', color: '#0F766E' },
          heading: { text: 'Spectra renders video' },
          caption: 'Spectra renders video',
        },
        {
          id: 'two',
          durationMs: 1000,
          background: { kind: 'IMAGE', mediaAssetId: photoId, fit: 'COVER' },
          caption: 'From assets this workspace owns',
        },
      ],
      ...overrides,
    };
  }

  async function createProject(t: Tenant, overrides: Record<string, unknown> = {}) {
    return send(t, 'POST', `${video(t)}/projects`, {
      name: `Launch clip ${randomUUID().slice(0, 8)}`,
      kind: 'SLIDESHOW',
      formatKey: 'SQUARE_1080x1080',
      storyboard: storyboard(),
      ...overrides,
    });
  }

  beforeAll(async () => {
    app = await createApp(getApiEnv());
    await app.init();
    await inject().ready();
    prisma = app.get(PrismaService);
    storage = new S3ObjectStorageProvider(getApiEnv());
    await storage.ensureBucket();
    queueService = app.get(QueueService);
    enqueueSpy = vi
      .spyOn(queueService, 'enqueue')
      .mockImplementation(async () => `stub-${randomUUID()}`);
    owner = await registerTenant('owner');
    other = await registerTenant('other');

    photoId = await storeAsset(
      owner,
      await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#DC2626' } })
        .jpeg()
        .toBuffer(),
      'image/jpeg',
      'photo.jpg',
    );
  }, 120_000);

  afterAll(async () => {
    enqueueSpy?.mockRestore();

    const assets = await prisma.client.mediaAsset.findMany({
      where: { organizationId: { in: tenants.map((t) => t.orgId) } },
      select: { storageKey: true },
    });
    for (const key of [...storedKeys, ...assets.map((a) => a.storageKey)]) {
      await storage.deleteObject(key).catch(() => undefined);
    }
    for (const tenant of tenants) {
      await prisma.client.organization
        .deleteMany({ where: { id: tenant.orgId } })
        .catch(() => undefined);
      await prisma.client.user
        .deleteMany({ where: { email: tenant.email } })
        .catch(() => undefined);
    }
    await app.close();
  });

  describe('capabilities and formats', () => {
    it('reports the engine it found, and that nothing here is generated', async () => {
      const res = await get(owner, `${video()}/capabilities`);

      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        available: boolean;
        engine: string;
        generatesVideo: boolean;
        generationNote: string;
        features: Record<string, boolean>;
      };
      expect(body.engine).toBe('ffmpeg');
      expect(body.generatesVideo).toBe(false);
      expect(body.generationNote).toContain('no generative-video provider');
      expect(body.features).toHaveProperty('burnedCaptions');
    });

    it('lists every output size with its own duration ceiling', async () => {
      const res = await get(owner, `${video()}/formats`);

      const body = res.json() as { formats: Array<{ key: string; maxDurationSeconds: number }> };
      expect(body.formats.map((f) => f.key)).toContain('VERTICAL_1080x1920');
      expect(body.formats.every((f) => f.maxDurationSeconds > 0)).toBe(true);
    });
  });

  describe('storyboard validation', () => {
    it('refuses a storyboard longer than its format allows, before anything is stored', async () => {
      const res = await createProject(owner, {
        formatKey: 'VERTICAL_1080x1920',
        storyboard: {
          scenes: Array.from({ length: 40 }, (_, index) => ({
            id: `s${index}`,
            durationMs: 6000,
            background: { kind: 'COLOR', color: '#000000' },
          })),
        },
      });

      expect(res.statusCode).toBe(422);
      expect(problemText(res.json())).toContain('180s limit');
      const count = await prisma.client.videoProject.count({
        where: { organizationId: owner.orgId },
      });
      expect(count).toBe(0);
    });

    it('refuses a transition that would swallow the scenes it joins, naming each one', async () => {
      const res = await createProject(owner, {
        storyboard: {
          transitionMs: 2000,
          scenes: [
            { id: 'a', durationMs: 1500, background: { kind: 'COLOR', color: '#000000' } },
            { id: 'b', durationMs: 1000, background: { kind: 'COLOR', color: '#000000' } },
          ],
        },
      });

      expect(res.statusCode).toBe(422);
      const text = problemText(res.json());
      expect(text).toContain('"a"');
      expect(text).toContain('"b"');
    });

    it('refuses an unknown format rather than guessing one', async () => {
      const res = await createProject(owner, { formatKey: 'CINEMA_8K' });

      expect(res.statusCode).toBe(422);
    });
  });

  describe('render lifecycle', () => {
    it('queues, runs and stores a real MP4 whose bytes match the plan', async () => {
      const project = await createProject(owner);
      expect(project.statusCode).toBe(201);
      const projectId = (project.json() as { project: { id: string } }).project.id;

      const queued = await postRender(owner, projectId, {
        captions: 'SRT',
        thumbnail: true,
        crf: 30,
      });
      expect(queued.statusCode).toBe(202);
      const queuedBody = queued.json() as { created: boolean; render: RenderBody };
      expect(queuedBody.created).toBe(true);
      // Queued means queued: no file, and no pretence of one.
      expect(queuedBody.render.status).toBe('QUEUED');
      expect(queuedBody.render.mediaAssetId).toBeNull();
      expect(queuedBody.render.plannedDurationMs).toBe(2000);

      const outcome = await runRender(queuedBody.render.id);
      expect(outcome.status).toBe('SUCCEEDED');

      const after = await get(owner, `${video()}/renders/${queuedBody.render.id}`);
      const render = (after.json() as { render: RenderBody }).render;
      expect(render.status).toBe('SUCCEEDED');
      expect(render.progressPercent).toBe(100);
      expect(render.failureReason).toBeNull();
      expect(render.mediaAssetId).toBeTruthy();
      expect(render.captionAssetId).toBeTruthy();
      expect(render.thumbnailAssetId).toBeTruthy();

      // The real proof: decode what object storage holds.
      const asset = await prisma.client.mediaAsset.findFirstOrThrow({
        where: { organizationId: owner.orgId, id: render.mediaAssetId! },
      });
      expect(asset.mimeType).toBe('video/mp4');
      expect(asset.kind).toBe('VIDEO');
      const bytes = await storage.getObject(asset.storageKey);
      expect(isMp4(bytes)).toBe(true);
      expect(bytes.length).toBe(asset.sizeBytes);

      const probe = await renderer().probeFile(asset.storageKey ? await writeTemp(bytes) : '');
      expect(probe.videoCodec).toBe('h264');
      expect(probe.width).toBe(1080);
      expect(probe.height).toBe(1080);
      expect(probe.durationMs).toBeGreaterThanOrEqual(1900);
      expect(probe.durationMs).toBeLessThanOrEqual(2100);

      // Stored metadata describes those same bytes.
      expect(render.widthPx).toBe(1080);
      expect(render.heightPx).toBe(1080);
      expect(render.durationMs).toBe(probe.durationMs);
    }, 180_000);

    it('stores captions and a poster frame as ordinary tenant-rooted assets', async () => {
      const project = await createProject(owner, { formatKey: 'VERTICAL_1080x1920' });
      const projectId = (project.json() as { project: { id: string } }).project.id;
      const queued = await postRender(owner, projectId, {
        captions: 'VTT',
        thumbnail: true,
        crf: 32,
      });
      const renderId = (queued.json() as { render: RenderBody }).render.id;
      await runRender(renderId);

      const render = (
        (await get(owner, `${video()}/renders/${renderId}`)).json() as { render: RenderBody }
      ).render;
      const caption = await prisma.client.mediaAsset.findFirstOrThrow({
        where: { organizationId: owner.orgId, id: render.captionAssetId! },
      });
      const poster = await prisma.client.mediaAsset.findFirstOrThrow({
        where: { organizationId: owner.orgId, id: render.thumbnailAssetId! },
      });

      // Every output lives under this tenant's renders prefix.
      for (const key of [caption.storageKey, poster.storageKey]) {
        expect(key.startsWith(`org/${owner.orgId}/ws/${owner.workspaceId}/renders/`)).toBe(true);
      }
      const vtt = (await storage.getObject(caption.storageKey)).toString('utf8');
      expect(vtt.startsWith('WEBVTT')).toBe(true);
      expect(vtt).toContain('-->');
      expect(vtt).toContain('Spectra renders video');

      const posterBytes = await storage.getObject(poster.storageKey);
      expect(posterBytes[0]).toBe(0xff);
      expect(posterBytes[1]).toBe(0xd8);
    }, 180_000);

    it('serves a finished render over a short-lived signed URL, and refuses one that is not finished', async () => {
      const project = await createProject(owner);
      const projectId = (project.json() as { project: { id: string } }).project.id;
      const queued = await postRender(owner, projectId, {
        captions: 'NONE',
        thumbnail: false,
        crf: 32,
      });
      const renderId = (queued.json() as { render: RenderBody }).render.id;

      // Still queued: there is nothing to download, and the API says so.
      const tooEarly = await get(owner, `${video()}/renders/${renderId}/url`);
      expect(tooEarly.statusCode).toBe(422);
      expect(problemText(tooEarly.json())).toContain('queued');

      await runRender(renderId);

      const signed = await get(owner, `${video()}/renders/${renderId}/url`);
      expect(signed.statusCode).toBe(200);
      const body = signed.json() as { url: string; expiresAt: string; mimeType: string };
      expect(body.mimeType).toBe('video/mp4');
      expect(body.url).toContain(`org/${owner.orgId}/ws/${owner.workspaceId}/renders/`);
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    }, 180_000);

    it('reuses an identical render instead of encoding the same seconds twice', async () => {
      const project = await createProject(owner);
      const projectId = (project.json() as { project: { id: string } }).project.id;
      const first = await postRender(owner, projectId, {
        captions: 'NONE',
        thumbnail: false,
        crf: 29,
      });
      const firstBody = first.json() as { created: boolean; render: RenderBody };
      await runRender(firstBody.render.id);

      const second = await postRender(owner, projectId, {
        captions: 'NONE',
        thumbnail: false,
        crf: 29,
      });
      const secondBody = second.json() as { created: boolean; render: RenderBody };

      expect(secondBody.created).toBe(false);
      expect(secondBody.render.id).toBe(firstBody.render.id);
      const count = await prisma.client.videoRender.count({
        where: { organizationId: owner.orgId, projectId },
      });
      expect(count).toBe(1);
    }, 180_000);

    it('re-renders when an input asset changes, because the hash covers it', async () => {
      const replaceable = await storeAsset(
        owner,
        await sharp({ create: { width: 800, height: 600, channels: 3, background: '#2563EB' } })
          .jpeg()
          .toBuffer(),
        'image/jpeg',
        'swap.jpg',
      );
      const project = await createProject(owner, {
        storyboard: {
          scenes: [
            {
              id: 'only',
              durationMs: 800,
              background: { kind: 'IMAGE', mediaAssetId: replaceable },
            },
          ],
        },
      });
      const projectId = (project.json() as { project: { id: string } }).project.id;
      const first = await postRender(owner, projectId, {
        captions: 'NONE',
        thumbnail: false,
      });
      const firstId = (first.json() as { render: RenderBody }).render.id;

      // The asset is replaced in place; its identity in the hash changes.
      await prisma.client.mediaAsset.updateMany({
        where: { organizationId: owner.orgId, id: replaceable },
        data: { sizeBytes: 999_999 },
      });

      const second = await postRender(owner, projectId, {
        captions: 'NONE',
        thumbnail: false,
      });
      const secondBody = second.json() as { created: boolean; render: RenderBody };

      expect(secondBody.created).toBe(true);
      expect(secondBody.render.id).not.toBe(firstId);
    }, 180_000);
  });

  describe('the queue path', () => {
    it('really enqueues a worker job, carrying the render id and its tenant', async () => {
      // The only test that touches the shared queue: it restores the real
      // enqueue, asserts the job exists with the payload the worker expects,
      // and removes it again before anything else can see it.
      enqueueSpy?.mockRestore();
      enqueueSpy = null;
      const connection = createRedisConnection(getApiEnv().REDIS_URL);
      const queue = new Queue(SYSTEM_QUEUE, { connection });
      try {
        const project = await createProject(owner);
        const projectId = (project.json() as { project: { id: string } }).project.id;

        const queued = await postRender(owner, projectId, {
          captions: 'NONE',
          thumbnail: false,
          crf: 33,
        });
        const render = (queued.json() as { render: RenderBody & { queueJobId?: string } }).render;

        expect(render.status).toBe('QUEUED');
        expect(render.queueJobId).toBeTruthy();
        const job = await queue.getJob(render.queueJobId!);
        expect(job).toBeTruthy();
        expect(job!.name).toBe('video.render.execute');
        expect((job!.data as { payload: { renderId: string } }).payload.renderId).toBe(render.id);
        expect((job!.data as { tenant: { organizationId: string } }).tenant.organizationId).toBe(
          owner.orgId,
        );

        await job!.remove().catch(() => undefined);
      } finally {
        await queue.close().catch(() => undefined);
        connection.disconnect();
        // Back to the stub for every later test.
        enqueueSpy = vi
          .spyOn(queueService, 'enqueue')
          .mockImplementation(async () => `stub-${randomUUID()}`);
      }
    }, 120_000);
  });

  describe('honest failure', () => {
    it('records a failed render with a reason, and never an asset', async () => {
      const project = await createProject(owner, {
        storyboard: {
          scenes: [
            { id: 'a', durationMs: 800, background: { kind: 'IMAGE', mediaAssetId: photoId } },
          ],
        },
      });
      const projectId = (project.json() as { project: { id: string } }).project.id;
      const queued = await postRender(owner, projectId, {
        captions: 'NONE',
        thumbnail: false,
      });
      const renderId = (queued.json() as { render: RenderBody }).render.id;

      // The asset disappears between queueing and rendering — the ordinary way
      // a real render fails.
      await prisma.client.mediaAsset.deleteMany({
        where: { organizationId: owner.orgId, id: photoId },
      });

      const outcome = await runRender(renderId);
      expect(outcome.status).toBe('FAILED');

      const body = (await get(owner, `${video()}/renders/${renderId}`)).json() as {
        render: RenderBody;
        failureText: string;
      };
      expect(body.render.status).toBe('FAILED');
      expect(body.render.failureReason).toBe('INPUT_UNAVAILABLE');
      expect(body.render.mediaAssetId).toBeNull();
      // The reason reads as a sentence, not a code the UI has to interpret.
      expect(body.failureText).toContain('could not be read');

      // Restore for the remaining tests.
      photoId = await storeAsset(
        owner,
        await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#DC2626' } })
          .jpeg()
          .toBuffer(),
        'image/jpeg',
        'photo.jpg',
      );
    }, 180_000);

    it('does not re-encode or re-bill a render that already reached a terminal state', async () => {
      const project = await createProject(owner);
      const projectId = (project.json() as { project: { id: string } }).project.id;
      const queued = await postRender(owner, projectId, {
        captions: 'NONE',
        thumbnail: false,
        crf: 32,
      });
      const renderId = (queued.json() as { render: RenderBody }).render.id;
      await runRender(renderId);
      const first = await prisma.client.videoRender.findUniqueOrThrow({ where: { id: renderId } });

      // A retry of a finished job: the handler must skip, not redo the work.
      const retry = await runRender(renderId);
      const second = await prisma.client.videoRender.findUniqueOrThrow({ where: { id: renderId } });

      expect(retry.status).toBe('SKIPPED');
      expect(retry.skipped).toBe(true);
      expect(second.mediaAssetId).toBe(first.mediaAssetId);
      expect(second.finishedAt?.getTime()).toBe(first.finishedAt?.getTime());
    }, 180_000);

    it('stops a running encode when it is cancelled, and says so', async () => {
      const project = await createProject(owner, {
        formatKey: 'LANDSCAPE_1920x1080',
        storyboard: {
          scenes: Array.from({ length: 8 }, (_, index) => ({
            id: `s${index}`,
            durationMs: 6000,
            background: { kind: 'COLOR', color: '#334155' },
          })),
        },
      });
      const projectId = (project.json() as { project: { id: string } }).project.id;
      const queued = await postRender(owner, projectId, {
        captions: 'NONE',
        thumbnail: false,
        crf: 32,
      });
      const renderId = (queued.json() as { render: RenderBody }).render.id;

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);
      const outcome = await runRender(renderId, controller.signal);

      expect(outcome.status).toBe('CANCELLED');
      const render = await prisma.client.videoRender.findUniqueOrThrow({ where: { id: renderId } });
      expect(render.status).toBe('CANCELLED');
      expect(render.failureReason).toBe('CANCELLED');
      expect(render.mediaAssetId).toBeNull();
    }, 180_000);

    it('cancels a queued render through the API without ever starting it', async () => {
      const project = await createProject(owner);
      const projectId = (project.json() as { project: { id: string } }).project.id;
      const queued = await postRender(owner, projectId, {
        captions: 'NONE',
        thumbnail: false,
        crf: 32,
      });
      const renderId = (queued.json() as { render: RenderBody }).render.id;

      const cancelled = await send(owner, 'POST', `${video()}/renders/${renderId}/cancel`);
      expect(cancelled.statusCode).toBe(201);
      expect((cancelled.json() as { render: RenderBody }).render.status).toBe('CANCELLED');

      // The worker picking it up afterwards must not resurrect it.
      const outcome = await runRender(renderId);
      expect(outcome.status).toBe('SKIPPED');

      const again = await send(owner, 'POST', `${video()}/renders/${renderId}/cancel`);
      expect(again.statusCode).toBe(422);
      expect(problemText(again.json())).toContain('already cancelled');
    }, 180_000);
  });

  describe('budget, isolation and permissions', () => {
    it('refuses a render the workspace budget will not allow, before a job exists', async () => {
      const project = await createProject(owner);
      const projectId = (project.json() as { project: { id: string } }).project.id;
      await prisma.client.budgetOperationLimit.create({
        data: {
          organizationId: owner.orgId,
          workspaceId: owner.workspaceId,
          kind: 'MEDIA_RENDER',
          maxRequests: 0,
        },
      });

      const res = await postRender(owner, projectId, {
        captions: 'NONE',
        thumbnail: false,
      });

      expect(res.statusCode).toBe(403);
      expect((res.json() as { type: string }).type).toContain('budget-exceeded');
      // Refused before a job exists: nothing queued, nothing to clean up.
      const renders = await prisma.client.videoRender.count({
        where: { organizationId: owner.orgId, projectId },
      });
      expect(renders).toBe(0);

      await prisma.client.budgetOperationLimit.deleteMany({
        where: { organizationId: owner.orgId, kind: 'MEDIA_RENDER' },
      });
    }, 120_000);

    it('gives another tenant the same 404 for a project, a render and a download', async () => {
      const project = await createProject(owner);
      const projectId = (project.json() as { project: { id: string } }).project.id;
      const queued = await postRender(owner, projectId, {
        captions: 'NONE',
        thumbnail: false,
        crf: 32,
      });
      const renderId = (queued.json() as { render: RenderBody }).render.id;
      await runRender(renderId);

      // Asked for inside the other tenant's own workspace: a missing resource
      // and a foreign one are indistinguishable.
      const foreignProject = await get(other, `${video(other)}/projects/${projectId}`);
      const foreignRender = await get(other, `${video(other)}/renders/${renderId}`);
      const foreignUrl = await get(other, `${video(other)}/renders/${renderId}/url`);
      const missing = await get(other, `${video(other)}/projects/${randomUUID()}`);

      expect(foreignProject.statusCode).toBe(404);
      expect(foreignRender.statusCode).toBe(404);
      expect(foreignUrl.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(problemText(foreignProject.json())).toBe(problemText(missing.json()));
    }, 180_000);

    it('refuses a storyboard pointing at another tenant’s media, without fetching it', async () => {
      const foreignAsset = await storeAsset(
        other,
        await sharp({ create: { width: 400, height: 400, channels: 3, background: '#16A34A' } })
          .jpeg()
          .toBuffer(),
        'image/jpeg',
        'foreign.jpg',
      );

      const created = await createProject(owner, {
        storyboard: {
          scenes: [
            {
              id: 'a',
              durationMs: 800,
              background: { kind: 'IMAGE', mediaAssetId: foreignAsset },
            },
          ],
        },
      });
      // The project may be stored — the asset reference is only resolved at
      // render time, and that is where it must fail.
      const projectId = (created.json() as { project: { id: string } }).project.id;
      const res = await postRender(owner, projectId, {
        captions: 'NONE',
        thumbnail: false,
      });

      expect(res.statusCode).toBe(404);
      const renders = await prisma.client.videoRender.count({
        where: { organizationId: owner.orgId, projectId },
      });
      expect(renders).toBe(0);
    }, 120_000);

    it('needs video:read to look and video:write to render', async () => {
      const project = await createProject(owner);
      const projectId = (project.json() as { project: { id: string } }).project.id;
      const reader = await registerTenant('reader');
      await prisma.client.membership.create({
        data: {
          organizationId: owner.orgId,
          userId: reader.userId,
          role: 'READ_ONLY',
          workspaceIds: [owner.workspaceId],
        },
      });

      const canRead = await get(
        { ...reader, workspaceId: owner.workspaceId },
        `${video(owner)}/projects/${projectId}`,
      );
      const cannotRender = await send(
        { ...reader, workspaceId: owner.workspaceId },
        'POST',
        `${video(owner)}/projects/${projectId}/renders`,
        { captions: 'NONE', thumbnail: false },
      );

      expect(canRead.statusCode).toBe(200);
      expect(cannotRender.statusCode).toBe(403);
      expect(problemText(cannotRender.json())).toContain('video:write');
    }, 120_000);
  });
});

/** Writes bytes to a temp file so ffprobe can read what storage returned. */
async function writeTemp(bytes: Buffer): Promise<string> {
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const path = join(tmpdir(), `spectra-probe-${randomUUID()}.mp4`);
  await writeFile(path, bytes);
  return path;
}
