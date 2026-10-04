import {
  VIDEO_FAILURE_REASON_TEXT,
  VIDEO_FORMATS,
  type CreateVideoProjectInput,
  type StartVideoRenderInput,
  type Storyboard,
  type UpdateVideoProjectInput,
  storyboardSchema,
} from '@spectra/contracts';
import { Prisma } from '@spectra/database';
import { FfmpegVideoRenderer, resolveVideoEngineOptions } from '@spectra/media-ffmpeg';
import { reserve } from '@spectra/metering';
import { TenantIsolationError } from '@spectra/security';
import { S3ObjectStorageProvider, assertKeyWithinTenant } from '@spectra/storage';
import { JOB_NAMES } from '@spectra/workflow-core';
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { VideoPlanError, buildVideoRenderPlan, videoRenderHash } from '@spectra/video-studio';

import { getApiEnv } from '../config/env';
import { AuditService } from '../infra/audit.service';
import { QueueService } from '../infra/queue.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal, TenantContext } from '../auth/types';

type Scope = { organizationId: string; workspaceId: string };

const SIGNED_URL_TTL_SECONDS = 15 * 60;

const RENDER_SELECT = {
  id: true,
  projectId: true,
  status: true,
  formatKey: true,
  crf: true,
  captions: true,
  thumbnail: true,
  progressPercent: true,
  plannedDurationMs: true,
  attempt: true,
  maxAttempts: true,
  cancelRequestedAt: true,
  startedAt: true,
  finishedAt: true,
  failureReason: true,
  failureDetail: true,
  engine: true,
  engineVersion: true,
  videoCodec: true,
  durationMs: true,
  widthPx: true,
  heightPx: true,
  sizeBytes: true,
  warnings: true,
  mediaAssetId: true,
  captionAssetId: true,
  thumbnailAssetId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.VideoRenderSelect;

const PROJECT_SELECT = {
  id: true,
  name: true,
  description: true,
  kind: true,
  status: true,
  formatKey: true,
  storyboard: true,
  brandId: true,
  contentItemId: true,
  campaignId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.VideoProjectSelect;

@Injectable()
export class VideoService {
  private readonly storage = new S3ObjectStorageProvider(getApiEnv());
  private readonly renderer = new FfmpegVideoRenderer(
    resolveVideoEngineOptions({
      ffmpegPath: getApiEnv().FFMPEG_PATH ?? null,
      ffprobePath: getApiEnv().FFPROBE_PATH ?? null,
      fontFile: getApiEnv().VIDEO_FONT_FILE ?? null,
      timeoutMs: getApiEnv().VIDEO_RENDER_TIMEOUT_MS,
    }),
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  /**
   * What this deployment can actually render. Probed from the installed
   * binary, never asserted: a missing engine or a build without libass is a
   * visible state with a reason, not a surprise halfway through a render.
   */
  async capabilities() {
    const capability = await this.renderer.capabilities();
    return {
      ...capability,
      /** Spectra renders; it does not generate. There is no video model here. */
      generatesVideo: false,
      generationNote:
        'Spectra composes video from the images, text and audio in this workspace. There is no generative-video provider wired, and no prompt is sent anywhere.',
      maxAttempts: getApiEnv().VIDEO_RENDER_MAX_ATTEMPTS,
      timeoutMs: getApiEnv().VIDEO_RENDER_TIMEOUT_MS,
      failureReasons: VIDEO_FAILURE_REASON_TEXT,
    };
  }

  formats() {
    return { formats: VIDEO_FORMATS };
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  async listProjects(tenant: TenantContext, status?: string) {
    const projects = await this.prisma.client.videoProject.findMany({
      where: {
        ...this.scope(tenant),
        deletedAt: null,
        ...(status ? { status: status as never } : {}),
      },
      select: { ...PROJECT_SELECT, _count: { select: { renders: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    return { projects };
  }

  async getProject(tenant: TenantContext, projectId: string) {
    const project = await this.requireProject(tenant, projectId);
    const renders = await this.prisma.client.videoRender.findMany({
      where: { ...this.scope(tenant), projectId },
      select: RENDER_SELECT,
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    // Planning here too, so the editor can show warnings before a render costs
    // anything — and the same code path decides both.
    const preview = this.planQuietly(project.storyboard, project.formatKey);
    return {
      project,
      renders,
      plan: preview.plan
        ? {
            totalDurationMs: preview.plan.totalDurationMs,
            scenes: preview.plan.scenes.length,
            warnings: preview.plan.warnings,
          }
        : null,
      problems: preview.problems,
    };
  }

  async createProject(tenant: TenantContext, principal: Principal, input: CreateVideoProjectInput) {
    // Planning before storing: an unrenderable storyboard is refused at the
    // door rather than becoming a row that always fails.
    this.assertPlannable(input.storyboard, input.formatKey);
    await this.assertLinksInWorkspace(tenant, input);

    const project = await this.prisma.client.videoProject.create({
      data: {
        ...this.scope(tenant),
        name: input.name,
        description: input.description ?? null,
        kind: input.kind,
        formatKey: input.formatKey,
        storyboard: input.storyboard as unknown as Prisma.InputJsonValue,
        brandId: input.brandId ?? null,
        contentItemId: input.contentItemId ?? null,
        campaignId: input.campaignId ?? null,
        createdById: principal.userId,
        updatedById: principal.userId,
      },
      select: PROJECT_SELECT,
    });
    await this.audit.record({
      ...this.scope(tenant),
      actorUserId: principal.userId,
      action: 'video.project.created',
      resourceType: 'VideoProject',
      resourceId: project.id,
      changes: { kind: input.kind, formatKey: input.formatKey },
    });
    return { project };
  }

  async updateProject(
    tenant: TenantContext,
    principal: Principal,
    projectId: string,
    input: UpdateVideoProjectInput,
  ) {
    const existing = await this.requireProject(tenant, projectId);
    const storyboard = input.storyboard ?? (existing.storyboard as unknown as Storyboard);
    const formatKey = input.formatKey ?? existing.formatKey;
    this.assertPlannable(storyboard, formatKey);
    await this.assertLinksInWorkspace(tenant, input);

    await this.prisma.client.videoProject.updateMany({
      where: { ...this.scope(tenant), id: projectId },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.formatKey === undefined ? {} : { formatKey: input.formatKey }),
        ...(input.brandId === undefined ? {} : { brandId: input.brandId }),
        ...(input.contentItemId === undefined ? {} : { contentItemId: input.contentItemId }),
        ...(input.campaignId === undefined ? {} : { campaignId: input.campaignId }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.storyboard === undefined
          ? {}
          : { storyboard: input.storyboard as unknown as Prisma.InputJsonValue }),
        updatedById: principal.userId,
      },
    });
    return this.getProject(tenant, projectId);
  }

  async archiveProject(tenant: TenantContext, principal: Principal, projectId: string) {
    await this.requireProject(tenant, projectId);
    await this.prisma.client.videoProject.updateMany({
      where: { ...this.scope(tenant), id: projectId },
      data: { status: 'ARCHIVED', deletedAt: new Date(), updatedById: principal.userId },
    });
    return { archived: true };
  }

  // -------------------------------------------------------------------------
  // Renders
  // -------------------------------------------------------------------------

  /**
   * Queues one render. Everything that can be checked cheaply is checked
   * before a job exists: the storyboard plans, the engine can do what the
   * storyboard asks, the inputs are in this workspace, and the budget allows
   * it. A render that gets queued is one that had a real chance of finishing.
   */
  async startRender(
    tenant: TenantContext,
    principal: Principal,
    projectId: string,
    input: StartVideoRenderInput,
  ) {
    const project = await this.requireProject(tenant, projectId);
    const formatKey = input.formatKey ?? project.formatKey;
    const storyboard = storyboardSchema.parse(project.storyboard);
    const plan = this.assertPlannable(storyboard, formatKey);

    const capability = await this.renderer.capabilities();
    if (!capability.available) {
      // Honest 422, not a queued job that will fail in a minute's time.
      throw new UnprocessableEntityException(capability.reason);
    }
    const needs: string[] = [];
    if (plan.scenes.some((scene) => scene.texts.length > 0) && !capability.features.textOverlays) {
      needs.push('text overlays');
    }
    if (plan.burnCaptions && !capability.features.burnedCaptions) needs.push('burned-in captions');
    if (plan.transitionMs > 0 && !capability.features.crossfades) needs.push('crossfades');
    if (plan.audio && !capability.features.audioBed) needs.push('an audio bed');
    if (needs.length > 0) {
      throw new UnprocessableEntityException(
        `This storyboard needs ${needs.join(', ')}, which the installed ffmpeg build does not provide. ${capability.missing.join(' ')}`,
      );
    }

    // Inputs are checked here, under the tenant scope, so a foreign asset is a
    // 404 before any work — never a fetch.
    const assetVersions = await this.assetVersions(tenant, plan);

    const hash = videoRenderHash(
      plan,
      { crf: input.crf, captions: input.captions, thumbnail: input.thumbnail },
      assetVersions,
    );
    const renderKey = `${project.id}:${hash}`;

    const existing = await this.prisma.client.videoRender.findFirst({
      where: { ...this.scope(tenant), renderKey },
      select: RENDER_SELECT,
    });
    if (existing && existing.status !== 'FAILED' && existing.status !== 'TIMED_OUT') {
      // Same inputs, same settings: reuse rather than encode the same seconds
      // twice. A failed one may be retried, so it does not block a new attempt.
      return { created: false, render: existing };
    }

    // Local rendering bills nobody, but it is real work: it counts against the
    // MEDIA_RENDER operation limit, checked before a job is queued.
    const reservationKey = `video-render-${renderKey}`;
    await reserve(this.prisma.client, {
      ...this.scope(tenant),
      kind: 'MEDIA_RENDER',
      provider: 'ffmpeg',
      requests: 1,
      idempotencyKey: reservationKey,
      resourceType: 'VIDEO_PROJECT',
      resourceId: project.id,
      ttlMs: 60 * 60_000,
    });

    const render = await this.prisma.client.videoRender.create({
      data: {
        ...this.scope(tenant),
        projectId: project.id,
        status: 'QUEUED',
        formatKey,
        storyboard: project.storyboard as Prisma.InputJsonValue,
        crf: input.crf,
        captions: input.captions,
        thumbnail: input.thumbnail,
        renderHash: hash,
        renderKey,
        plannedDurationMs: plan.totalDurationMs,
        maxAttempts: getApiEnv().VIDEO_RENDER_MAX_ATTEMPTS,
        createdById: principal.userId,
      },
      select: RENDER_SELECT,
    });

    const jobId = await this.queue.enqueue(
      JOB_NAMES.videoRenderExecute,
      {
        renderId: render.id,
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
      },
      {
        idempotencyKey: `video-render-${render.id}`,
        tenant: this.scope(tenant),
        retry: {
          maxAttempts: getApiEnv().VIDEO_RENDER_MAX_ATTEMPTS,
          backoff: { type: 'exponential', delayMs: 5000, maxDelayMs: 60_000 },
        },
      },
    );
    await this.prisma.client.videoRender.updateMany({
      where: { ...this.scope(tenant), id: render.id },
      data: { queueJobId: jobId },
    });

    await this.audit.record({
      ...this.scope(tenant),
      actorUserId: principal.userId,
      action: 'video.render.queued',
      resourceType: 'VideoRender',
      resourceId: render.id,
      changes: { formatKey, plannedDurationMs: plan.totalDurationMs, captions: input.captions },
    });

    return { created: true, render: { ...render, queueJobId: jobId } };
  }

  async getRender(tenant: TenantContext, renderId: string) {
    const render = await this.prisma.client.videoRender.findFirst({
      where: { ...this.scope(tenant), id: renderId },
      select: RENDER_SELECT,
    });
    if (!render) throw new TenantIsolationError('Video render not found');
    return {
      render,
      // A failure always reads as a sentence, not a code the UI has to guess at.
      failureText: render.failureReason ? VIDEO_FAILURE_REASON_TEXT[render.failureReason] : null,
    };
  }

  /**
   * Asks for cancellation. A queued job is removed outright; a running one is
   * flagged, and the worker's own abort signal stops the encoder.
   */
  async cancelRender(tenant: TenantContext, principal: Principal, renderId: string) {
    const render = await this.prisma.client.videoRender.findFirst({
      where: { ...this.scope(tenant), id: renderId },
      select: { id: true, status: true, queueJobId: true },
    });
    if (!render) throw new TenantIsolationError('Video render not found');
    if (render.status !== 'QUEUED' && render.status !== 'RUNNING') {
      throw new UnprocessableEntityException(
        `This render is already ${render.status.toLowerCase()}; there is nothing to cancel.`,
      );
    }

    await this.prisma.client.videoRender.updateMany({
      where: { ...this.scope(tenant), id: renderId },
      data: { cancelRequestedAt: new Date() },
    });

    let removed = false;
    if (render.queueJobId) {
      removed = await this.queue.cancel(render.queueJobId).catch(() => false);
    }
    if (removed || render.status === 'QUEUED') {
      // It never started, so this process can close it out truthfully.
      await this.prisma.client.videoRender.updateMany({
        where: { ...this.scope(tenant), id: renderId, status: { in: ['QUEUED'] } },
        data: {
          status: 'CANCELLED',
          failureReason: 'CANCELLED',
          finishedAt: new Date(),
        },
      });
    }
    await this.audit.record({
      ...this.scope(tenant),
      actorUserId: principal.userId,
      action: 'video.render.cancelled',
      resourceType: 'VideoRender',
      resourceId: renderId,
      changes: { removedFromQueue: removed },
    });
    return this.getRender(tenant, renderId);
  }

  /** A short-lived signed URL. Only a SUCCEEDED render has anything to serve. */
  async renderUrl(tenant: TenantContext, renderId: string, which: 'video' | 'captions' | 'poster') {
    const render = await this.prisma.client.videoRender.findFirst({
      where: { ...this.scope(tenant), id: renderId },
      select: { status: true, mediaAssetId: true, captionAssetId: true, thumbnailAssetId: true },
    });
    if (!render) throw new TenantIsolationError('Video render not found');
    if (render.status !== 'SUCCEEDED') {
      throw new UnprocessableEntityException(
        `This render is ${render.status.toLowerCase()} and has no file to download.`,
      );
    }
    const assetId =
      which === 'video'
        ? render.mediaAssetId
        : which === 'captions'
          ? render.captionAssetId
          : render.thumbnailAssetId;
    if (!assetId) {
      throw new UnprocessableEntityException(`This render has no ${which} file.`);
    }
    const asset = await this.prisma.client.mediaAsset.findFirst({
      where: { ...this.scope(tenant), id: assetId },
      select: { storageKey: true, mimeType: true, sizeBytes: true },
    });
    if (!asset) throw new TenantIsolationError('Video render not found');
    // Belt and braces: the key is re-checked against this tenant's prefix.
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
    // The workspace guard has already resolved this route's workspace.
    return { organizationId: tenant.organizationId, workspaceId: tenant.workspaceId as string };
  }

  private async requireProject(tenant: TenantContext, projectId: string) {
    const project = await this.prisma.client.videoProject.findFirst({
      where: { ...this.scope(tenant), id: projectId, deletedAt: null },
      select: PROJECT_SELECT,
    });
    // A foreign project and a missing one are the same answer: no existence leak.
    if (!project) throw new TenantIsolationError('Video project not found');
    return project;
  }

  /** Plans, turning a plan error into a 422 that lists every problem at once. */
  private assertPlannable(storyboard: unknown, formatKey: string) {
    try {
      return buildVideoRenderPlan(storyboardSchema.parse(storyboard), formatKey);
    } catch (error: unknown) {
      if (error instanceof VideoPlanError) {
        throw new UnprocessableEntityException(error.problems.join(' '));
      }
      throw new UnprocessableEntityException(
        error instanceof Error ? error.message : 'This storyboard cannot be rendered.',
      );
    }
  }

  private planQuietly(storyboard: unknown, formatKey: string) {
    try {
      return {
        plan: buildVideoRenderPlan(storyboardSchema.parse(storyboard), formatKey),
        problems: [] as string[],
      };
    } catch (error: unknown) {
      return {
        plan: null,
        problems:
          error instanceof VideoPlanError
            ? error.problems
            : [error instanceof Error ? error.message : 'This storyboard cannot be planned.'],
      };
    }
  }

  /**
   * Every asset the plan needs, read under this tenant. Their identities feed
   * the render hash, so replacing an image really does re-render.
   */
  private async assetVersions(
    tenant: TenantContext,
    plan: { imageAssetIds: string[]; audio: { mediaAssetId: string } | null },
  ): Promise<Record<string, string>> {
    const ids = [...plan.imageAssetIds, ...(plan.audio ? [plan.audio.mediaAssetId] : [])];
    if (ids.length === 0) return {};
    const assets = await this.prisma.client.mediaAsset.findMany({
      where: { ...this.scope(tenant), id: { in: ids } },
      select: { id: true, createdAt: true, sizeBytes: true, mimeType: true },
    });
    const found = new Map(assets.map((asset) => [asset.id, asset]));
    for (const id of ids) {
      const asset = found.get(id);
      if (!asset) {
        throw new TenantIsolationError('Video project references a media asset that is not here');
      }
      const isAudio = plan.audio?.mediaAssetId === id && !plan.imageAssetIds.includes(id);
      const expected = isAudio ? 'audio/' : 'image/';
      if (!asset.mimeType.startsWith(expected)) {
        throw new UnprocessableEntityException(
          `Media asset ${id} is ${asset.mimeType}, which cannot be used as ${isAudio ? 'an audio bed' : 'a scene background'}.`,
        );
      }
    }
    return Object.fromEntries(
      ids.map((id) => {
        const asset = found.get(id)!;
        return [id, `${asset.createdAt.toISOString()}:${asset.sizeBytes}`];
      }),
    );
  }

  /** Links must point inside this workspace, or they are the same 404. */
  private async assertLinksInWorkspace(
    tenant: TenantContext,
    input: { brandId?: string | null; contentItemId?: string | null; campaignId?: string | null },
  ): Promise<void> {
    const scope = this.scope(tenant);
    if (input.brandId) {
      const brand = await this.prisma.client.brand.findFirst({
        where: { ...scope, id: input.brandId },
        select: { id: true },
      });
      if (!brand) throw new TenantIsolationError('Brand not found');
    }
    if (input.contentItemId) {
      const item = await this.prisma.client.contentItem.findFirst({
        where: { ...scope, id: input.contentItemId },
        select: { id: true },
      });
      if (!item) throw new TenantIsolationError('Content item not found');
    }
    if (input.campaignId) {
      const campaign = await this.prisma.client.campaign.findFirst({
        where: { ...scope, id: input.campaignId },
        select: { id: true },
      });
      if (!campaign) throw new TenantIsolationError('Campaign not found');
    }
  }
}
