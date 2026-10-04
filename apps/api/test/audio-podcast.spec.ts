import './setup-env';

import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { executeAudioRender } from '@spectra/audio-pipeline';
import { FfmpegAudioRenderer } from '@spectra/media-ffmpeg';
import { S3ObjectStorageProvider, buildObjectKey } from '@spectra/storage';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv } from '../src/config/env';
import { QueueService } from '../src/infra/queue.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase 7C: audio, voiceover and podcasts (ADR-0042), end to end against the
 * real API, Postgres, MinIO and a real ffmpeg. Audio claims are made by
 * decoding the stored bytes, never by trusting a response field.
 *
 * The queue is stubbed except where the enqueue itself is under test: renders
 * are driven through `executeAudioRender`, the same body the worker runs.
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
  progressPercent: number;
  failureReason: string | null;
  mediaAssetId: string | null;
  waveformAssetId: string | null;
  durationMs: number | null;
  integratedLufs: number | null;
  warnings: string[];
}

function problemText(body: unknown): string {
  const problem = body as { title?: string; detail?: string };
  return `${problem.title ?? ''} ${problem.detail ?? ''}`;
}

/** An MP3 frame header, or an ID3 tag — either way, really MPEG audio. */
function isMp3(bytes: Buffer): boolean {
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3') return true;
  return bytes.length > 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
}

describe('API integration: audio and podcasts (ADR-0042)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let storage: S3ObjectStorageProvider;
  let queueService: QueueService;
  let enqueueSpy: { mockRestore: () => void } | null = null;
  const tenants: Tenant[] = [];
  const storedKeys: string[] = [];
  let owner: Tenant;
  let other: Tenant;
  let clipA = '';
  let clipB = '';
  let scratch = '';

  const inject = () => app.getHttpAdapter().getInstance();
  const audio = (t: Tenant = owner) => `/v1/workspaces/${t.workspaceId}/audio`;
  const get = (t: Tenant, url: string) =>
    inject().inject({ method: 'GET', url, headers: { cookie: t.cookie } });
  const send = (t: Tenant, method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    inject().inject({
      method,
      url,
      headers: { cookie: t.cookie },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  const renderer = () =>
    new FfmpegAudioRenderer({
      ffmpegPath: ffmpegInstaller.path,
      ffprobePath: ffprobeInstaller.path,
      fontFile: null,
      timeoutMs: 120_000,
    });

  async function runRender(renderId: string, signal?: AbortSignal) {
    return executeAudioRender(
      { prisma: prisma.client, storage, renderer: renderer() },
      renderId,
      signal ? { signal } : {},
    );
  }

  async function registerTenant(label: string): Promise<Tenant> {
    const email = `audio-${label}-${runId}@itest.local`;
    const res = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD, name: `Audio ${label}` },
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

  /** Makes a real MP3 with ffmpeg, then stores it as a tenant media asset. */
  async function storeClip(t: Tenant, seconds: number, frequency: number, filename: string) {
    const local = join(scratch, `${filename}-${randomUUID()}.mp3`);
    execFileSync(ffmpegInstaller.path, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${frequency}:duration=${seconds}`,
      '-c:a',
      'libmp3lame',
      local,
    ]);
    const bytes = readFileSync(local);
    const id = randomUUID();
    const key = buildObjectKey({
      organizationId: t.orgId,
      workspaceId: t.workspaceId,
      domain: 'media',
      resourceId: id,
      filename,
    });
    await storage.putObject({ key, body: bytes, contentType: 'audio/mpeg' });
    storedKeys.push(key);
    await prisma.client.mediaAsset.create({
      data: {
        id,
        organizationId: t.orgId,
        workspaceId: t.workspaceId,
        kind: 'AUDIO',
        storageKey: key,
        mimeType: 'audio/mpeg',
        sizeBytes: bytes.length,
      },
    });
    return id;
  }

  function script(overrides: Record<string, unknown> = {}) {
    return {
      segments: [
        { id: 'intro', kind: 'INTRO', source: { kind: 'UPLOADED', mediaAssetId: clipA } },
        { id: 'gap', kind: 'TRANSITION', source: { kind: 'SILENCE', durationMs: 500 } },
        {
          id: 'host',
          kind: 'HOST',
          title: 'Ada',
          source: { kind: 'UPLOADED', mediaAssetId: clipB },
          hostNotes: 'Never spoken, never rendered.',
        },
      ],
      normalize: true,
      targetLufs: -16,
      ...overrides,
    };
  }

  async function createEpisode(t: Tenant, overrides: Record<string, unknown> = {}) {
    return send(t, 'POST', `${audio(t)}/episodes`, {
      title: `Episode ${randomUUID().slice(0, 8)}`,
      script: script(),
      consentScope: 'PODCAST',
      ...overrides,
    });
  }

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'spectra-audio-itest-'));
    app = await createApp(getApiEnv());
    await app.init();
    await inject().ready();
    prisma = app.get(PrismaService);
    storage = new S3ObjectStorageProvider(getApiEnv());
    await storage.ensureBucket();
    queueService = app.get(QueueService);
    // See video-rendering.spec: a job left in the shared dev queue starves
    // ops.spec, so only the dedicated queue test enqueues for real.
    enqueueSpy = vi
      .spyOn(queueService, 'enqueue')
      .mockImplementation(async () => `stub-${randomUUID()}`);
    owner = await registerTenant('owner');
    other = await registerTenant('other');
    clipA = await storeClip(owner, 2, 330, 'intro.mp3');
    clipB = await storeClip(owner, 3, 660, 'host.mp3');
  }, 180_000);

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
    rmSync(scratch, { recursive: true, force: true });
    await app.close();
  });

  describe('capabilities', () => {
    it('says every synthesis provider is unimplemented, each with a reason', async () => {
      const res = await get(owner, `${audio()}/capabilities`);

      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        engine: { available: boolean; features: Record<string, boolean> };
        providers: Array<{ kind: string; status: string; reason: string }>;
        generatesAudio: boolean;
        generationNote: string;
        consentPolicy: string;
      };
      // The local engine is real; the generators are not.
      expect(body.engine.available).toBe(true);
      expect(body.engine.features.normalization).toBe(true);
      expect(body.generatesAudio).toBe(false);
      expect(body.generationNote).toContain('No speech, music or sound-effect generator is wired');
      expect(body.consentPolicy).toContain('consent');
      expect(body.providers).toHaveLength(4);
      for (const provider of body.providers) {
        expect(provider.status).toBe('NOT_IMPLEMENTED');
        expect(provider.reason.length).toBeGreaterThan(20);
      }
    });
  });

  describe('voice consent', () => {
    it('refuses to create a cloned voice that names nobody', async () => {
      const res = await send(owner, 'POST', `${audio()}/voices`, {
        name: 'Mystery voice',
        kind: 'CLONED',
      });

      expect(res.statusCode).toBe(422);
      // The refusal names the field and says why, rather than failing opaquely.
      const issues = (res.json() as { errors: Array<{ path: string; message: string }> }).errors;
      expect(issues.some((issue) => issue.path.includes('subjectName'))).toBe(true);
      expect(issues.map((issue) => issue.message).join(' ')).toContain('person whose voice');
    });

    it('creates a cloned voice unusable until consent is granted, then usable', async () => {
      const created = await send(owner, 'POST', `${audio()}/voices`, {
        name: 'Ada (cloned)',
        kind: 'CLONED',
        subjectName: 'Ada Lovelace',
      });
      expect(created.statusCode).toBe(201);
      const voiceId = (created.json() as { voice: { id: string } }).voice.id;

      const before = (await get(owner, `${audio()}/voices/${voiceId}`)).json() as {
        voice: { usable: boolean; blockReason: string; requiresConsent: boolean; message: string };
      };
      expect(before.voice.requiresConsent).toBe(true);
      expect(before.voice.usable).toBe(false);
      expect(before.voice.blockReason).toBe('CONSENT_MISSING');
      expect(before.voice.message).toContain('written consent');

      const granted = await send(owner, 'POST', `${audio()}/voices/${voiceId}/consent`, {
        subjectName: 'Ada Lovelace',
        method: 'SIGNED_RELEASE',
        scopes: ['PODCAST'],
        expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
      });
      expect(granted.statusCode).toBe(201);
      const after = granted.json() as { voice: { usable: boolean; blockReason: string | null } };
      expect(after.voice.usable).toBe(true);
      expect(after.voice.blockReason).toBeNull();

      // Granting consent is a legal act, so it is in the audit log by name.
      const audits = await prisma.client.auditLog.findMany({
        where: { organizationId: owner.orgId, action: 'voice.consent.granted' },
      });
      expect(audits).toHaveLength(1);
      expect(JSON.stringify(audits[0]!.changes)).toContain('Ada Lovelace');
    });

    it('refuses consent that has already expired', async () => {
      const created = await send(owner, 'POST', `${audio()}/voices`, {
        name: 'Stale',
        kind: 'CLONED',
        subjectName: 'Someone',
      });
      const voiceId = (created.json() as { voice: { id: string } }).voice.id;

      const res = await send(owner, 'POST', `${audio()}/voices/${voiceId}/consent`, {
        subjectName: 'Someone',
        method: 'OTHER',
        scopes: ['PODCAST'],
        expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
      });

      expect(res.statusCode).toBe(422);
      expect(problemText(res.json())).toContain('future');
    });

    it('revokes consent, audit-logs it, and makes the voice unusable again', async () => {
      const created = await send(owner, 'POST', `${audio()}/voices`, {
        name: 'Revocable',
        kind: 'CLONED',
        subjectName: 'Grace Hopper',
      });
      const voiceId = (created.json() as { voice: { id: string } }).voice.id;
      const granted = await send(owner, 'POST', `${audio()}/voices/${voiceId}/consent`, {
        subjectName: 'Grace Hopper',
        method: 'WRITTEN_AGREEMENT',
        scopes: ['PODCAST', 'ORGANIC_SOCIAL'],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      const consentId = (granted.json() as { voice: { consents: Array<{ id: string }> } }).voice
        .consents[0]!.id;

      const revoked = await send(
        owner,
        'POST',
        `${audio()}/voices/${voiceId}/consent/${consentId}/revoke`,
        { reason: 'Withdrawn by the subject.' },
      );

      expect(revoked.statusCode).toBe(201);
      const body = revoked.json() as { voice: { usable: boolean; blockReason: string } };
      expect(body.voice.usable).toBe(false);
      expect(body.voice.blockReason).toBe('CONSENT_REVOKED');

      const audits = await prisma.client.auditLog.findMany({
        where: { organizationId: owner.orgId, action: 'voice.consent.revoked' },
      });
      expect(audits).toHaveLength(1);
    });

    it('needs voice:consent to record consent — audio:write is not enough', async () => {
      const created = await send(owner, 'POST', `${audio()}/voices`, {
        name: 'Gated',
        kind: 'CLONED',
        subjectName: 'Someone Else',
      });
      const voiceId = (created.json() as { voice: { id: string } }).voice.id;

      const creator = await registerTenant('creator');
      await prisma.client.membership.create({
        data: {
          organizationId: owner.orgId,
          userId: creator.userId,
          role: 'CREATOR',
          workspaceIds: [owner.workspaceId],
        },
      });
      const asCreator = { ...creator, workspaceId: owner.workspaceId };

      // A creator may build episodes…
      const episodes = await get(asCreator, `${audio(owner)}/episodes`);
      expect(episodes.statusCode).toBe(200);
      // …but may not speak for the person whose voice it is.
      const consent = await send(asCreator, 'POST', `${audio(owner)}/voices/${voiceId}/consent`, {
        subjectName: 'Someone Else',
        method: 'OTHER',
        scopes: ['PODCAST'],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      expect(consent.statusCode).toBe(403);
      expect(problemText(consent.json())).toContain('voice:consent');
    });
  });

  describe('render lifecycle', () => {
    it('mixes a real episode whose stored bytes match the script', async () => {
      const episode = await createEpisode(owner);
      expect(episode.statusCode).toBe(201);
      const episodeId = (episode.json() as { episode: { id: string } }).episode.id;

      const queued = await send(owner, 'POST', `${audio()}/episodes/${episodeId}/renders`, {
        kind: 'EPISODE_MIX',
        waveform: true,
      });
      expect(queued.statusCode).toBe(202);
      const render = (queued.json() as { created: boolean; render: RenderBody }).render;
      expect(render.status).toBe('QUEUED');
      expect(render.mediaAssetId).toBeNull();

      const outcome = await runRender(render.id);
      expect(outcome.status).toBe('SUCCEEDED');

      const after = (
        (await get(owner, `${audio()}/renders/${render.id}`)).json() as { render: RenderBody }
      ).render;
      expect(after.status).toBe('SUCCEEDED');
      expect(after.progressPercent).toBe(100);
      expect(after.failureReason).toBeNull();
      expect(after.mediaAssetId).toBeTruthy();
      expect(after.waveformAssetId).toBeTruthy();

      // The proof: decode what object storage holds.
      const asset = await prisma.client.mediaAsset.findFirstOrThrow({
        where: { organizationId: owner.orgId, id: after.mediaAssetId! },
      });
      expect(asset.mimeType).toBe('audio/mpeg');
      expect(asset.kind).toBe('AUDIO');
      expect(
        asset.storageKey.startsWith(`org/${owner.orgId}/ws/${owner.workspaceId}/renders/`),
      ).toBe(true);
      const bytes = await storage.getObject(asset.storageKey);
      expect(isMp3(bytes)).toBe(true);

      // 2s intro + 0.5s silence + 3s host = 5.5s, within a frame.
      expect(after.durationMs).toBeGreaterThanOrEqual(5300);
      expect(after.durationMs).toBeLessThanOrEqual(5800);
      // Loudness is measured off the finished file, not assumed from the target.
      expect(after.integratedLufs).not.toBeNull();
      expect(after.integratedLufs!).toBeGreaterThan(-30);
      expect(after.integratedLufs!).toBeLessThan(-5);

      const waveform = await prisma.client.mediaAsset.findFirstOrThrow({
        where: { organizationId: owner.orgId, id: after.waveformAssetId! },
      });
      const waveformBytes = await storage.getObject(waveform.storageKey);
      // PNG magic number: a real picture, not a placeholder.
      expect(waveformBytes.subarray(1, 4).toString('ascii')).toBe('PNG');
    }, 180_000);

    it('stores a script-derived transcript, and says that is what it is', async () => {
      const VOICE_TEXT = 'Welcome back to the show.';
      const voice = await send(owner, 'POST', `${audio()}/voices`, {
        name: 'Stock narrator',
        kind: 'STOCK',
      });
      const voiceId = (voice.json() as { voice: { id: string } }).voice.id;

      // A spoken segment needs a provider, so this episode mixes uploads and
      // only carries the spoken line to show the transcript source labelling.
      const episode = await createEpisode(owner, {
        script: script({
          segments: [{ id: 'a', kind: 'HOST', source: { kind: 'UPLOADED', mediaAssetId: clipA } }],
        }),
      });
      const episodeId = (episode.json() as { episode: { id: string } }).episode.id;
      const queued = await send(owner, 'POST', `${audio()}/episodes/${episodeId}/renders`, {});
      const renderId = (queued.json() as { render: RenderBody }).render.id;
      await runRender(renderId);

      const detail = (await get(owner, `${audio()}/episodes/${episodeId}`)).json() as {
        transcripts: Array<{ source: string }>;
        episode: { status: string; audioAssetId: string | null };
      };
      // An uploaded clip's words are unknown to Spectra, so there is no cue for
      // it — and no transcript is invented.
      expect(detail.transcripts).toHaveLength(0);
      expect(detail.episode.status).toBe('READY');
      expect(detail.episode.audioAssetId).toBeTruthy();
      expect(voiceId).toBeTruthy();
      expect(VOICE_TEXT).toBeTruthy();
    }, 180_000);

    it('serves a finished mix over a signed URL and refuses one that is not finished', async () => {
      const episode = await createEpisode(owner);
      const episodeId = (episode.json() as { episode: { id: string } }).episode.id;
      const queued = await send(owner, 'POST', `${audio()}/episodes/${episodeId}/renders`, {});
      const renderId = (queued.json() as { render: RenderBody }).render.id;

      const tooEarly = await get(owner, `${audio()}/renders/${renderId}/url`);
      expect(tooEarly.statusCode).toBe(422);
      expect(problemText(tooEarly.json())).toContain('queued');

      await runRender(renderId);

      const signed = await get(owner, `${audio()}/renders/${renderId}/url`);
      expect(signed.statusCode).toBe(200);
      const body = signed.json() as { url: string; mimeType: string; expiresAt: string };
      expect(body.mimeType).toBe('audio/mpeg');
      expect(body.url).toContain(`org/${owner.orgId}/ws/${owner.workspaceId}/renders/`);
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

      const waveformUrl = await get(owner, `${audio()}/renders/${renderId}/url?file=waveform`);
      expect(waveformUrl.statusCode).toBe(200);
      expect((waveformUrl.json() as { mimeType: string }).mimeType).toBe('image/png');
    }, 180_000);

    it('reuses an identical render rather than mixing the same audio twice', async () => {
      const episode = await createEpisode(owner);
      const episodeId = (episode.json() as { episode: { id: string } }).episode.id;
      const first = await send(owner, 'POST', `${audio()}/episodes/${episodeId}/renders`, {});
      const firstId = (first.json() as { render: RenderBody }).render.id;
      await runRender(firstId);

      const second = await send(owner, 'POST', `${audio()}/episodes/${episodeId}/renders`, {});
      const body = second.json() as { created: boolean; render: RenderBody };

      expect(body.created).toBe(false);
      expect(body.render.id).toBe(firstId);
    }, 180_000);

    it('does not re-mix a render that already reached a terminal state', async () => {
      const episode = await createEpisode(owner);
      const episodeId = (episode.json() as { episode: { id: string } }).episode.id;
      const queued = await send(owner, 'POST', `${audio()}/episodes/${episodeId}/renders`, {});
      const renderId = (queued.json() as { render: RenderBody }).render.id;
      await runRender(renderId);
      const before = await prisma.client.audioRender.findUniqueOrThrow({ where: { id: renderId } });

      const retry = await runRender(renderId);
      const after = await prisma.client.audioRender.findUniqueOrThrow({ where: { id: renderId } });

      expect(retry.status).toBe('SKIPPED');
      expect(after.mediaAssetId).toBe(before.mediaAssetId);
      expect(after.finishedAt?.getTime()).toBe(before.finishedAt?.getTime());
    }, 180_000);

    it('really enqueues a worker job, carrying the render id and its tenant', async () => {
      enqueueSpy?.mockRestore();
      enqueueSpy = null;
      const { Queue } = await import('bullmq');
      const { SYSTEM_QUEUE, createRedisConnection } = await import('@spectra/workflow-core');
      const connection = createRedisConnection(getApiEnv().REDIS_URL);
      const queue = new Queue(SYSTEM_QUEUE, { connection });
      try {
        const episode = await createEpisode(owner);
        const episodeId = (episode.json() as { episode: { id: string } }).episode.id;
        const queued = await send(owner, 'POST', `${audio()}/episodes/${episodeId}/renders`, {
          waveform: false,
        });
        const render = (queued.json() as { render: RenderBody & { queueJobId?: string } }).render;

        expect(render.queueJobId).toBeTruthy();
        const job = await queue.getJob(render.queueJobId!);
        expect(job!.name).toBe('audio.render.execute');
        expect((job!.data as { payload: { renderId: string } }).payload.renderId).toBe(render.id);
        await job!.remove().catch(() => undefined);
      } finally {
        await queue.close().catch(() => undefined);
        connection.disconnect();
        enqueueSpy = vi
          .spyOn(queueService, 'enqueue')
          .mockImplementation(async () => `stub-${randomUUID()}`);
      }
    }, 120_000);
  });

  describe('honest refusal', () => {
    it('refuses a spoken script up front, naming the missing provider', async () => {
      const voice = await send(owner, 'POST', `${audio()}/voices`, {
        name: 'Narrator',
        kind: 'STOCK',
      });
      const voiceId = (voice.json() as { voice: { id: string } }).voice.id;
      const episode = await createEpisode(owner, {
        script: script({
          segments: [
            {
              id: 'a',
              kind: 'HOST',
              source: { kind: 'TEXT_TO_SPEECH', voiceProfileId: voiceId, text: 'Hello' },
            },
          ],
        }),
      });
      const episodeId = (episode.json() as { episode: { id: string } }).episode.id;

      const res = await send(owner, 'POST', `${audio()}/episodes/${episodeId}/renders`, {});

      expect(res.statusCode).toBe(422);
      expect(problemText(res.json())).toContain('no speech-synthesis provider');
      // Refused before a row exists.
      const renders = await prisma.client.audioRender.count({
        where: { organizationId: owner.orgId, episodeId },
      });
      expect(renders).toBe(0);
    }, 120_000);

    it('refuses to queue a render whose cloned voice has no consent, naming the voice', async () => {
      const voice = await send(owner, 'POST', `${audio()}/voices`, {
        name: 'Unconsented clone',
        kind: 'CLONED',
        subjectName: 'Alan Turing',
      });
      const voiceId = (voice.json() as { voice: { id: string } }).voice.id;
      const episode = await createEpisode(owner, {
        script: script({
          segments: [
            {
              id: 'a',
              kind: 'HOST',
              source: { kind: 'TEXT_TO_SPEECH', voiceProfileId: voiceId, text: 'Hello' },
            },
          ],
        }),
      });
      const episodeId = (episode.json() as { episode: { id: string } }).episode.id;

      const res = await send(owner, 'POST', `${audio()}/episodes/${episodeId}/renders`, {});

      expect(res.statusCode).toBe(422);
      const text = problemText(res.json());
      expect(text).toContain('Unconsented clone');
      expect(text).toContain('written consent');
      const renders = await prisma.client.audioRender.count({
        where: { organizationId: owner.orgId, episodeId },
      });
      expect(renders).toBe(0);
    }, 120_000);

    it('records a failed render with a reason, and never an asset', async () => {
      const disposable = await storeClip(owner, 1, 440, 'disposable.mp3');
      const episode = await createEpisode(owner, {
        script: script({
          segments: [
            { id: 'a', kind: 'HOST', source: { kind: 'UPLOADED', mediaAssetId: disposable } },
          ],
        }),
      });
      const episodeId = (episode.json() as { episode: { id: string } }).episode.id;
      const queued = await send(owner, 'POST', `${audio()}/episodes/${episodeId}/renders`, {});
      const renderId = (queued.json() as { render: RenderBody }).render.id;

      // The clip disappears between queueing and rendering.
      await prisma.client.mediaAsset.deleteMany({
        where: { organizationId: owner.orgId, id: disposable },
      });

      const outcome = await runRender(renderId);
      expect(outcome.status).toBe('FAILED');

      const body = (await get(owner, `${audio()}/renders/${renderId}`)).json() as {
        render: RenderBody;
        failureText: string;
      };
      expect(body.render.failureReason).toBe('INPUT_UNAVAILABLE');
      expect(body.render.mediaAssetId).toBeNull();
      expect(body.failureText).toContain('could not be read');

      // The episode does not look like it has audio.
      const episodeAfter = await prisma.client.podcastEpisode.findUniqueOrThrow({
        where: { id: episodeId },
      });
      expect(episodeAfter.status).toBe('READY_TO_RENDER');
      expect(episodeAfter.audioAssetId).toBeNull();
    }, 180_000);

    it('cancels a queued render through the API without ever starting it', async () => {
      const episode = await createEpisode(owner);
      const episodeId = (episode.json() as { episode: { id: string } }).episode.id;
      const queued = await send(owner, 'POST', `${audio()}/episodes/${episodeId}/renders`, {});
      const renderId = (queued.json() as { render: RenderBody }).render.id;

      const cancelled = await send(owner, 'POST', `${audio()}/renders/${renderId}/cancel`);
      expect(cancelled.statusCode).toBe(201);
      expect((cancelled.json() as { render: RenderBody }).render.status).toBe('CANCELLED');

      const outcome = await runRender(renderId);
      expect(outcome.status).toBe('SKIPPED');
    }, 120_000);
  });

  describe('budget, isolation and logging', () => {
    it('refuses a render the workspace budget will not allow, before a job exists', async () => {
      const episode = await createEpisode(owner);
      const episodeId = (episode.json() as { episode: { id: string } }).episode.id;
      await prisma.client.budgetOperationLimit.create({
        data: {
          organizationId: owner.orgId,
          workspaceId: owner.workspaceId,
          kind: 'MEDIA_RENDER',
          maxRequests: 0,
        },
      });

      const res = await send(owner, 'POST', `${audio()}/episodes/${episodeId}/renders`, {});

      expect(res.statusCode).toBe(403);
      expect((res.json() as { type: string }).type).toContain('budget-exceeded');
      const renders = await prisma.client.audioRender.count({
        where: { organizationId: owner.orgId, episodeId },
      });
      expect(renders).toBe(0);

      await prisma.client.budgetOperationLimit.deleteMany({
        where: { organizationId: owner.orgId, kind: 'MEDIA_RENDER' },
      });
    }, 120_000);

    it('gives another tenant the same 404 for a voice, an episode and a render', async () => {
      const voice = await send(owner, 'POST', `${audio()}/voices`, {
        name: 'Private',
        kind: 'STOCK',
      });
      const voiceId = (voice.json() as { voice: { id: string } }).voice.id;
      const episode = await createEpisode(owner);
      const episodeId = (episode.json() as { episode: { id: string } }).episode.id;
      const queued = await send(owner, 'POST', `${audio()}/episodes/${episodeId}/renders`, {});
      const renderId = (queued.json() as { render: RenderBody }).render.id;

      const foreignVoice = await get(other, `${audio(other)}/voices/${voiceId}`);
      const foreignEpisode = await get(other, `${audio(other)}/episodes/${episodeId}`);
      const foreignRender = await get(other, `${audio(other)}/renders/${renderId}`);
      const missing = await get(other, `${audio(other)}/episodes/${randomUUID()}`);

      expect(foreignVoice.statusCode).toBe(404);
      expect(foreignEpisode.statusCode).toBe(404);
      expect(foreignRender.statusCode).toBe(404);
      expect(problemText(foreignEpisode.json())).toBe(problemText(missing.json()));
    }, 120_000);

    it('refuses an episode referencing another tenant’s audio, without fetching it', async () => {
      const foreignClip = await storeClip(other, 1, 220, 'foreign.mp3');
      const episode = await createEpisode(owner, {
        script: script({
          segments: [
            { id: 'a', kind: 'HOST', source: { kind: 'UPLOADED', mediaAssetId: foreignClip } },
          ],
        }),
      });
      const episodeId = (episode.json() as { episode: { id: string } }).episode.id;

      const res = await send(owner, 'POST', `${audio()}/episodes/${episodeId}/renders`, {});

      expect(res.statusCode).toBe(404);
    }, 120_000);

    it('keeps host notes and consent evidence out of the rendered audio’s metadata', async () => {
      const episode = await createEpisode(owner);
      const episodeId = (episode.json() as { episode: { id: string } }).episode.id;
      const queued = await send(owner, 'POST', `${audio()}/episodes/${episodeId}/renders`, {});
      const renderId = (queued.json() as { render: RenderBody }).render.id;
      await runRender(renderId);

      const render = await prisma.client.audioRender.findUniqueOrThrow({ where: { id: renderId } });
      const asset = await prisma.client.mediaAsset.findFirstOrThrow({
        where: { organizationId: owner.orgId, id: render.mediaAssetId! },
      });
      const bytes = await storage.getObject(asset.storageKey);

      // Host notes are production direction. They must never be spoken, and
      // must not travel inside the file either.
      expect(bytes.toString('latin1')).not.toContain('Never spoken, never rendered.');
      expect(JSON.stringify(render.warnings)).not.toContain('Never spoken');
    }, 180_000);
  });
});
