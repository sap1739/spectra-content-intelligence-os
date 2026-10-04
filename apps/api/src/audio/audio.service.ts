import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import {
  AUDIO_FAILURE_REASON_TEXT,
  VOICE_BLOCK_REASON_TEXT,
  type CreatePodcastEpisodeInput,
  type CreateVoiceProfileInput,
  type RecordVoiceConsentInput,
  type RevokeVoiceConsentInput,
  type StartAudioRenderInput,
  type UpdatePodcastEpisodeInput,
  podcastScriptSchema,
} from '@spectra/contracts';
import {
  AudioPlanError,
  audioRenderHash,
  buildAudioRenderPlan,
  effectiveConsentStatus,
  evaluateVoiceUsability,
  resolveAudioCapabilities,
} from '@spectra/audio-core';
import { Prisma } from '@spectra/database';
import { FfmpegAudioRenderer, resolveVideoEngineOptions } from '@spectra/media-ffmpeg';
import { reserve } from '@spectra/metering';
import { TenantIsolationError } from '@spectra/security';
import { S3ObjectStorageProvider, assertKeyWithinTenant } from '@spectra/storage';
import { JOB_NAMES } from '@spectra/workflow-core';

import { getApiEnv } from '../config/env';
import { AuditService } from '../infra/audit.service';
import { QueueService } from '../infra/queue.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal, TenantContext } from '../auth/types';

type Scope = { organizationId: string; workspaceId: string };

const SIGNED_URL_TTL_SECONDS = 15 * 60;

const RENDER_SELECT = {
  id: true,
  episodeId: true,
  kind: true,
  status: true,
  progressPercent: true,
  attempt: true,
  maxAttempts: true,
  cancelRequestedAt: true,
  startedAt: true,
  finishedAt: true,
  failureReason: true,
  failureDetail: true,
  engine: true,
  audioCodec: true,
  durationMs: true,
  sizeBytes: true,
  integratedLufs: true,
  warnings: true,
  mediaAssetId: true,
  waveformAssetId: true,
  createdAt: true,
} satisfies Prisma.AudioRenderSelect;

const EPISODE_SELECT = {
  id: true,
  title: true,
  summary: true,
  showNotes: true,
  seasonNumber: true,
  episodeNumber: true,
  status: true,
  script: true,
  consentScope: true,
  audioAssetId: true,
  durationMs: true,
  integratedLufs: true,
  contentItemId: true,
  campaignId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PodcastEpisodeSelect;

const VOICE_SELECT = {
  id: true,
  name: true,
  kind: true,
  language: true,
  description: true,
  providerId: true,
  providerVoiceId: true,
  subjectName: true,
  createdAt: true,
} satisfies Prisma.VoiceProfileSelect;

@Injectable()
export class AudioService {
  private readonly storage = new S3ObjectStorageProvider(getApiEnv());
  private readonly renderer = new FfmpegAudioRenderer(
    resolveVideoEngineOptions({
      ffmpegPath: getApiEnv().FFMPEG_PATH ?? null,
      ffprobePath: getApiEnv().FFPROBE_PATH ?? null,
      timeoutMs: getApiEnv().VIDEO_RENDER_TIMEOUT_MS,
    }),
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  /**
   * What this deployment can actually do with audio. The engine half is probed;
   * the synthesis half reports `NOT_IMPLEMENTED` with a sentence, because no
   * speech, audio or music provider is wired (ADR-0042).
   */
  async capabilities() {
    const engine = await this.renderer.capabilities();
    // No adapters are registered: the registry is empty on purpose, and the
    // capability list says so rather than leaving it to be inferred.
    const providers = resolveAudioCapabilities({});
    return {
      engine,
      providers,
      generatesAudio: false,
      generationNote:
        'Spectra mixes, normalizes and visualises audio this workspace already has. No speech, music or sound-effect generator is wired, and no audio is sent anywhere.',
      consentPolicy:
        'A voice that imitates a real person cannot be used without a granted, unexpired consent record covering the intended use.',
      failureReasons: AUDIO_FAILURE_REASON_TEXT,
    };
  }

  // -------------------------------------------------------------------------
  // Voices and consent
  // -------------------------------------------------------------------------

  async listVoices(tenant: TenantContext) {
    const voices = await this.prisma.client.voiceProfile.findMany({
      where: { ...this.scope(tenant), deletedAt: null },
      select: { ...VOICE_SELECT, consents: { orderBy: { createdAt: 'desc' }, take: 1 } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const now = new Date();
    return {
      voices: voices.map((voice) => this.decorateVoice(voice, now)),
    };
  }

  async createVoice(tenant: TenantContext, principal: Principal, input: CreateVoiceProfileInput) {
    const voice = await this.prisma.client.voiceProfile.create({
      data: {
        ...this.scope(tenant),
        name: input.name,
        kind: input.kind,
        language: input.language,
        description: input.description ?? null,
        providerId: input.providerId ?? null,
        providerVoiceId: input.providerVoiceId ?? null,
        subjectName: input.subjectName ?? null,
        createdById: principal.userId,
      },
      select: VOICE_SELECT,
    });
    await this.audit.record({
      ...this.scope(tenant),
      actorUserId: principal.userId,
      action: 'voice.profile.created',
      resourceType: 'VoiceProfile',
      resourceId: voice.id,
      // The subject's name is the point of the record for a cloned voice.
      changes: { kind: input.kind, subjectName: input.subjectName ?? null },
    });
    return { voice: this.decorateVoice({ ...voice, consents: [] }, new Date()) };
  }

  /**
   * Records consent. This is the only way a cloned voice becomes usable, and
   * every call is audit-logged with who recorded it and what it covers.
   */
  async recordConsent(
    tenant: TenantContext,
    principal: Principal,
    voiceId: string,
    input: RecordVoiceConsentInput,
  ) {
    const voice = await this.requireVoice(tenant, voiceId);
    const expiresAt = new Date(input.expiresAt);
    if (expiresAt.getTime() <= Date.now()) {
      throw new UnprocessableEntityException('Consent must expire in the future.');
    }
    if (input.evidenceAssetId) {
      const asset = await this.prisma.client.mediaAsset.findFirst({
        where: { ...this.scope(tenant), id: input.evidenceAssetId },
        select: { id: true },
      });
      if (!asset) throw new TenantIsolationError('Evidence asset not found');
    }

    const consent = await this.prisma.client.voiceConsentRecord.create({
      data: {
        ...this.scope(tenant),
        voiceProfileId: voice.id,
        subjectName: input.subjectName,
        subjectEmail: input.subjectEmail ?? null,
        method: input.method,
        evidenceAssetId: input.evidenceAssetId ?? null,
        reference: input.reference ?? null,
        scopes: input.scopes,
        status: 'GRANTED',
        grantedAt: new Date(),
        expiresAt,
        obtainedByUserId: principal.userId,
      },
    });
    await this.audit.record({
      ...this.scope(tenant),
      actorUserId: principal.userId,
      action: 'voice.consent.granted',
      resourceType: 'VoiceConsentRecord',
      resourceId: consent.id,
      changes: {
        voiceProfileId: voice.id,
        subjectName: input.subjectName,
        scopes: input.scopes,
        method: input.method,
        expiresAt: expiresAt.toISOString(),
      },
    });
    return this.getVoice(tenant, voice.id);
  }

  /**
   * Revokes consent. Takes effect immediately — a render already queued is
   * stopped when the worker re-checks consent.
   */
  async revokeConsent(
    tenant: TenantContext,
    principal: Principal,
    voiceId: string,
    consentId: string,
    input: RevokeVoiceConsentInput,
  ) {
    await this.requireVoice(tenant, voiceId);
    const consent = await this.prisma.client.voiceConsentRecord.findFirst({
      where: { ...this.scope(tenant), id: consentId, voiceProfileId: voiceId },
      select: { id: true, status: true },
    });
    if (!consent) throw new TenantIsolationError('Consent record not found');
    if (consent.status === 'REVOKED') {
      throw new UnprocessableEntityException('This consent has already been revoked.');
    }

    await this.prisma.client.voiceConsentRecord.updateMany({
      where: { ...this.scope(tenant), id: consentId },
      data: { status: 'REVOKED', revokedAt: new Date(), revokedReason: input.reason },
    });
    await this.audit.record({
      ...this.scope(tenant),
      actorUserId: principal.userId,
      action: 'voice.consent.revoked',
      resourceType: 'VoiceConsentRecord',
      resourceId: consentId,
      changes: { voiceProfileId: voiceId, reason: input.reason },
    });
    return this.getVoice(tenant, voiceId);
  }

  async getVoice(tenant: TenantContext, voiceId: string) {
    const voice = await this.prisma.client.voiceProfile.findFirst({
      where: { ...this.scope(tenant), id: voiceId, deletedAt: null },
      select: { ...VOICE_SELECT, consents: { orderBy: { createdAt: 'desc' } } },
    });
    if (!voice) throw new TenantIsolationError('Voice not found');
    return { voice: this.decorateVoice(voice, new Date()) };
  }

  // -------------------------------------------------------------------------
  // Episodes
  // -------------------------------------------------------------------------

  async listEpisodes(tenant: TenantContext) {
    const episodes = await this.prisma.client.podcastEpisode.findMany({
      where: { ...this.scope(tenant), deletedAt: null },
      select: { ...EPISODE_SELECT, _count: { select: { renders: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    return { episodes };
  }

  async getEpisode(tenant: TenantContext, episodeId: string) {
    const episode = await this.requireEpisode(tenant, episodeId);
    const [renders, transcripts] = await Promise.all([
      this.prisma.client.audioRender.findMany({
        where: { ...this.scope(tenant), episodeId },
        select: RENDER_SELECT,
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.client.transcript.findMany({
        where: { ...this.scope(tenant), episodeId },
        select: { id: true, source: true, language: true, cues: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
    ]);
    const preview = this.planQuietly(episode.script);
    const voices = await this.voiceReadiness(tenant, preview.voiceProfileIds, episode.consentScope);
    return {
      episode,
      renders,
      transcripts,
      plan: preview.plan
        ? { segments: preview.plan.segments.length, warnings: preview.plan.warnings }
        : null,
      problems: preview.problems,
      /** Per-voice consent state, so the editor can show it before a render. */
      voices,
    };
  }

  async createEpisode(
    tenant: TenantContext,
    principal: Principal,
    input: CreatePodcastEpisodeInput,
  ) {
    this.assertPlannable(input.script);
    const episode = await this.prisma.client.podcastEpisode.create({
      data: {
        ...this.scope(tenant),
        title: input.title,
        summary: input.summary ?? null,
        showNotes: input.showNotes ?? null,
        seasonNumber: input.seasonNumber ?? null,
        episodeNumber: input.episodeNumber ?? null,
        script: input.script as unknown as Prisma.InputJsonValue,
        consentScope: input.consentScope,
        contentItemId: input.contentItemId ?? null,
        campaignId: input.campaignId ?? null,
        createdById: principal.userId,
        updatedById: principal.userId,
      },
      select: EPISODE_SELECT,
    });
    await this.audit.record({
      ...this.scope(tenant),
      actorUserId: principal.userId,
      action: 'podcast.episode.created',
      resourceType: 'PodcastEpisode',
      resourceId: episode.id,
      changes: { title: input.title, consentScope: input.consentScope },
    });
    return { episode };
  }

  async updateEpisode(
    tenant: TenantContext,
    principal: Principal,
    episodeId: string,
    input: UpdatePodcastEpisodeInput,
  ) {
    await this.requireEpisode(tenant, episodeId);
    if (input.script) this.assertPlannable(input.script);
    await this.prisma.client.podcastEpisode.updateMany({
      where: { ...this.scope(tenant), id: episodeId },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.showNotes === undefined ? {} : { showNotes: input.showNotes }),
        ...(input.seasonNumber === undefined ? {} : { seasonNumber: input.seasonNumber }),
        ...(input.episodeNumber === undefined ? {} : { episodeNumber: input.episodeNumber }),
        ...(input.consentScope === undefined ? {} : { consentScope: input.consentScope }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.contentItemId === undefined ? {} : { contentItemId: input.contentItemId }),
        ...(input.campaignId === undefined ? {} : { campaignId: input.campaignId }),
        ...(input.script === undefined
          ? {}
          : { script: input.script as unknown as Prisma.InputJsonValue }),
        updatedById: principal.userId,
      },
    });
    return this.getEpisode(tenant, episodeId);
  }

  async archiveEpisode(tenant: TenantContext, principal: Principal, episodeId: string) {
    await this.requireEpisode(tenant, episodeId);
    await this.prisma.client.podcastEpisode.updateMany({
      where: { ...this.scope(tenant), id: episodeId },
      data: { status: 'ARCHIVED', deletedAt: new Date(), updatedById: principal.userId },
    });
    return { archived: true };
  }

  // -------------------------------------------------------------------------
  // Renders
  // -------------------------------------------------------------------------

  /**
   * Queues a render. Consent, synthesis availability, engine capability, input
   * ownership and budget are all checked before a job exists, so a queued
   * render is one that had a real chance of finishing.
   */
  async startRender(
    tenant: TenantContext,
    principal: Principal,
    episodeId: string,
    input: StartAudioRenderInput,
  ) {
    const episode = await this.requireEpisode(tenant, episodeId);
    const script = podcastScriptSchema.parse(episode.script);
    const plan = this.assertPlannable(script);

    const engine = await this.renderer.capabilities();
    if (!engine.available) throw new UnprocessableEntityException(engine.reason);
    if (plan.normalize && !engine.features.normalization) {
      throw new UnprocessableEntityException(
        `This episode asks to be loudness-normalized, which the installed ffmpeg build cannot do. ${engine.missing.join(' ')}`,
      );
    }

    // Consent first: a blocked voice refuses the render here, by name.
    const voices = await this.voiceReadiness(tenant, plan.voiceProfileIds, episode.consentScope);
    const blocked = voices.filter((voice) => !voice.usable);
    if (blocked.length > 0) {
      throw new UnprocessableEntityException(
        blocked.map((voice) => `${voice.name}: ${voice.message}`).join(' '),
      );
    }

    // No synthesis provider exists, so a script that needs one is refused with
    // the reason rather than queued to fail.
    if (plan.requiresSynthesis) {
      const providers = resolveAudioCapabilities({});
      const tts = providers.find((provider) => provider.kind === 'TEXT_TO_SPEECH')!;
      if (tts.status !== 'AVAILABLE') {
        throw new UnprocessableEntityException(
          `${AUDIO_FAILURE_REASON_TEXT.TTS_NOT_CONFIGURED} ${tts.reason}`,
        );
      }
    }

    const assetVersions = await this.assetVersions(tenant, plan.audioAssetIds);
    const hash = audioRenderHash(
      plan,
      { kind: input.kind, waveform: input.waveform },
      assetVersions,
    );
    const renderKey = `${episode.id}:${hash}`;

    const existing = await this.prisma.client.audioRender.findFirst({
      where: { ...this.scope(tenant), renderKey },
      select: RENDER_SELECT,
    });
    if (existing && existing.status !== 'FAILED' && existing.status !== 'TIMED_OUT') {
      return { created: false, render: existing };
    }

    const reservationKey = `audio-render-${renderKey}`;
    await reserve(this.prisma.client, {
      ...this.scope(tenant),
      kind: 'MEDIA_RENDER',
      provider: 'ffmpeg',
      requests: 1,
      idempotencyKey: reservationKey,
      resourceType: 'PODCAST_EPISODE',
      resourceId: episode.id,
      ttlMs: 60 * 60_000,
    });

    const render = await this.prisma.client.audioRender.create({
      data: {
        ...this.scope(tenant),
        episodeId: episode.id,
        kind: input.kind,
        status: 'QUEUED',
        script: episode.script as Prisma.InputJsonValue,
        audiogram: (input.audiogram ?? null) as Prisma.InputJsonValue,
        renderHash: hash,
        renderKey,
        maxAttempts: getApiEnv().VIDEO_RENDER_MAX_ATTEMPTS,
        createdById: principal.userId,
      },
      select: RENDER_SELECT,
    });

    const jobId = await this.queue.enqueue(
      JOB_NAMES.audioRenderExecute,
      {
        renderId: render.id,
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
      },
      {
        idempotencyKey: `audio-render-${render.id}`,
        tenant: this.scope(tenant),
        retry: {
          maxAttempts: getApiEnv().VIDEO_RENDER_MAX_ATTEMPTS,
          backoff: { type: 'exponential', delayMs: 5000, maxDelayMs: 60_000 },
        },
      },
    );
    await this.prisma.client.audioRender.updateMany({
      where: { ...this.scope(tenant), id: render.id },
      data: { queueJobId: jobId },
    });
    await this.prisma.client.podcastEpisode.updateMany({
      where: { ...this.scope(tenant), id: episode.id },
      data: { status: 'RENDERING' },
    });

    await this.audit.record({
      ...this.scope(tenant),
      actorUserId: principal.userId,
      action: 'podcast.render.queued',
      resourceType: 'AudioRender',
      resourceId: render.id,
      changes: { kind: input.kind, segments: plan.segments.length },
    });

    return { created: true, render: { ...render, queueJobId: jobId } };
  }

  async getRender(tenant: TenantContext, renderId: string) {
    const render = await this.prisma.client.audioRender.findFirst({
      where: { ...this.scope(tenant), id: renderId },
      select: RENDER_SELECT,
    });
    if (!render) throw new TenantIsolationError('Audio render not found');
    return {
      render,
      failureText: render.failureReason ? AUDIO_FAILURE_REASON_TEXT[render.failureReason] : null,
    };
  }

  async cancelRender(tenant: TenantContext, principal: Principal, renderId: string) {
    const render = await this.prisma.client.audioRender.findFirst({
      where: { ...this.scope(tenant), id: renderId },
      select: { id: true, status: true, queueJobId: true },
    });
    if (!render) throw new TenantIsolationError('Audio render not found');
    if (render.status !== 'QUEUED' && render.status !== 'RUNNING') {
      throw new UnprocessableEntityException(
        `This render is already ${render.status.toLowerCase()}; there is nothing to cancel.`,
      );
    }
    await this.prisma.client.audioRender.updateMany({
      where: { ...this.scope(tenant), id: renderId },
      data: { cancelRequestedAt: new Date() },
    });
    let removed = false;
    if (render.queueJobId) {
      removed = await this.queue.cancel(render.queueJobId).catch(() => false);
    }
    if (removed || render.status === 'QUEUED') {
      await this.prisma.client.audioRender.updateMany({
        where: { ...this.scope(tenant), id: renderId, status: { in: ['QUEUED'] } },
        data: { status: 'CANCELLED', failureReason: 'CANCELLED', finishedAt: new Date() },
      });
    }
    await this.audit.record({
      ...this.scope(tenant),
      actorUserId: principal.userId,
      action: 'podcast.render.cancelled',
      resourceType: 'AudioRender',
      resourceId: renderId,
      changes: { removedFromQueue: removed },
    });
    return this.getRender(tenant, renderId);
  }

  async renderUrl(tenant: TenantContext, renderId: string, which: 'audio' | 'waveform') {
    const render = await this.prisma.client.audioRender.findFirst({
      where: { ...this.scope(tenant), id: renderId },
      select: { status: true, mediaAssetId: true, waveformAssetId: true },
    });
    if (!render) throw new TenantIsolationError('Audio render not found');
    if (render.status !== 'SUCCEEDED') {
      throw new UnprocessableEntityException(
        `This render is ${render.status.toLowerCase()} and has no file to download.`,
      );
    }
    const assetId = which === 'audio' ? render.mediaAssetId : render.waveformAssetId;
    if (!assetId) throw new UnprocessableEntityException(`This render has no ${which} file.`);
    const asset = await this.prisma.client.mediaAsset.findFirst({
      where: { ...this.scope(tenant), id: assetId },
      select: { storageKey: true, mimeType: true, sizeBytes: true },
    });
    if (!asset) throw new TenantIsolationError('Audio render not found');
    assertKeyWithinTenant(asset.storageKey, this.scope(tenant));
    const signed = await this.storage.createSignedDownloadUrl(
      asset.storageKey,
      SIGNED_URL_TTL_SECONDS,
    );
    return {
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private scope(tenant: TenantContext): Scope {
    return { organizationId: tenant.organizationId, workspaceId: tenant.workspaceId as string };
  }

  /** Adds the live consent verdict to a stored voice, so storage can go stale. */
  private decorateVoice(
    voice: {
      id: string;
      name: string;
      kind: 'STOCK' | 'CLONED' | 'CUSTOM_SYNTHETIC';
      consents: Array<{
        id: string;
        status: 'PENDING' | 'GRANTED' | 'REVOKED' | 'EXPIRED';
        scopes: string[];
        expiresAt: Date | null;
        revokedAt: Date | null;
        subjectName?: string;
        grantedAt?: Date | null;
        reference?: string | null;
      }>;
    } & Record<string, unknown>,
    now: Date,
  ) {
    const latest = voice.consents[0] ?? null;
    const verdict = evaluateVoiceUsability({
      voiceProfileId: voice.id,
      kind: voice.kind,
      consent: latest
        ? {
            status: effectiveConsentStatus(latest.status, latest.expiresAt, latest.revokedAt, now),
            scopes: latest.scopes as never,
            expiresAt: latest.expiresAt,
            revokedAt: latest.revokedAt,
          }
        : null,
      // Reported against the narrowest real use; the episode re-checks its own.
      scope: 'PODCAST',
      now,
    });
    return {
      ...voice,
      consents: voice.consents.map((consent) => ({
        ...consent,
        status: effectiveConsentStatus(consent.status, consent.expiresAt, consent.revokedAt, now),
      })),
      requiresConsent: verdict.requiresConsent,
      usable: verdict.usable,
      blockReason: verdict.reason,
      message: verdict.message,
    };
  }

  /** Per-voice readiness for one episode's intended use. */
  private async voiceReadiness(
    tenant: TenantContext,
    voiceProfileIds: readonly string[],
    consentScope: string,
  ) {
    if (voiceProfileIds.length === 0) return [];
    const voices = await this.prisma.client.voiceProfile.findMany({
      where: { ...this.scope(tenant), id: { in: [...voiceProfileIds] }, deletedAt: null },
      select: {
        id: true,
        name: true,
        kind: true,
        subjectName: true,
        consents: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    const found = new Map(voices.map((voice) => [voice.id, voice]));
    const now = new Date();
    return voiceProfileIds.map((id) => {
      const voice = found.get(id);
      if (!voice) {
        // A missing voice is not a silent pass: it blocks, by name.
        return {
          id,
          name: 'Unknown voice',
          kind: 'CLONED' as const,
          usable: false,
          reason: 'CONSENT_MISSING' as const,
          message: 'This voice is not in this workspace.',
          requiresConsent: true,
        };
      }
      const latest = voice.consents[0] ?? null;
      const verdict = evaluateVoiceUsability({
        voiceProfileId: id,
        kind: voice.kind,
        consent: latest
          ? {
              status: effectiveConsentStatus(
                latest.status,
                latest.expiresAt,
                latest.revokedAt,
                now,
              ),
              scopes: latest.scopes as never,
              expiresAt: latest.expiresAt,
              revokedAt: latest.revokedAt,
            }
          : null,
        scope: consentScope as never,
        now,
      });
      return {
        id,
        name: voice.name,
        kind: voice.kind,
        subjectName: voice.subjectName,
        usable: verdict.usable,
        reason: verdict.reason,
        message:
          verdict.message ?? (verdict.reason ? VOICE_BLOCK_REASON_TEXT[verdict.reason] : null),
        requiresConsent: verdict.requiresConsent,
      };
    });
  }

  private async requireEpisode(tenant: TenantContext, episodeId: string) {
    const episode = await this.prisma.client.podcastEpisode.findFirst({
      where: { ...this.scope(tenant), id: episodeId, deletedAt: null },
      select: EPISODE_SELECT,
    });
    if (!episode) throw new TenantIsolationError('Episode not found');
    return episode;
  }

  private async requireVoice(tenant: TenantContext, voiceId: string) {
    const voice = await this.prisma.client.voiceProfile.findFirst({
      where: { ...this.scope(tenant), id: voiceId, deletedAt: null },
      select: { id: true, kind: true, name: true },
    });
    if (!voice) throw new TenantIsolationError('Voice not found');
    return voice;
  }

  private assertPlannable(script: unknown) {
    try {
      return buildAudioRenderPlan(podcastScriptSchema.parse(script));
    } catch (error: unknown) {
      if (error instanceof AudioPlanError) {
        throw new UnprocessableEntityException(error.problems.join(' '));
      }
      throw new UnprocessableEntityException(
        error instanceof Error ? error.message : 'This script cannot be rendered.',
      );
    }
  }

  private planQuietly(script: unknown) {
    try {
      const plan = buildAudioRenderPlan(podcastScriptSchema.parse(script));
      return { plan, problems: [] as string[], voiceProfileIds: plan.voiceProfileIds };
    } catch (error: unknown) {
      return {
        plan: null,
        problems:
          error instanceof AudioPlanError
            ? error.problems
            : [error instanceof Error ? error.message : 'This script cannot be planned.'],
        voiceProfileIds: [] as string[],
      };
    }
  }

  private async assetVersions(
    tenant: TenantContext,
    assetIds: readonly string[],
  ): Promise<Record<string, string>> {
    if (assetIds.length === 0) return {};
    const assets = await this.prisma.client.mediaAsset.findMany({
      where: { ...this.scope(tenant), id: { in: [...assetIds] } },
      select: { id: true, createdAt: true, sizeBytes: true, mimeType: true },
    });
    const found = new Map(assets.map((asset) => [asset.id, asset]));
    for (const id of assetIds) {
      const asset = found.get(id);
      if (!asset) {
        throw new TenantIsolationError('Episode references a media asset that is not here');
      }
      if (!asset.mimeType.startsWith('audio/')) {
        throw new UnprocessableEntityException(
          `Media asset ${id} is ${asset.mimeType}, which cannot be used as audio.`,
        );
      }
    }
    return Object.fromEntries(
      assetIds.map((id) => {
        const asset = found.get(id)!;
        return [id, `${asset.createdAt.toISOString()}:${asset.sizeBytes}`];
      }),
    );
  }
}
