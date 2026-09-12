import { randomUUID } from 'node:crypto';

import { Injectable, PayloadTooLargeException, UnprocessableEntityException } from '@nestjs/common';
import type {
  MediaUploadCompleteInput,
  MediaUploadTicketInput,
  ProcessImageInput,
} from '@spectra/contracts';
import { SharpImageRenderer } from '@spectra/media-sharp';
import { TenantIsolationError } from '@spectra/security';
import { S3ObjectStorageProvider, buildObjectKey, validateUpload } from '@spectra/storage';

import { getApiEnv } from '../config/env';
import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal, TenantContext } from '../auth/types';

const MAX_SOURCE_BYTES = 10 * 1024 * 1024; // 10 MB decoded
/**
 * Every upload lands on one key derived from its ticket id, so completing an
 * upload never takes a caller-supplied path — only the ticket it was issued.
 */
const UPLOAD_FILENAME = 'upload.bin';
/** Long enough to send a large file, short enough that a leaked link is stale. */
const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/**
 * Media rendering. Image processing is REAL (sharp); video, audio and
 * HTML-to-image renderers are honestly reported as unavailable until their
 * engines (ffmpeg, headless chromium) are wired — the UI never implies they work.
 */
/** The asset kind a stored file is, from what storage says it is. */
function mediaKindFor(mimeType: string): 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'OTHER' {
  if (mimeType.startsWith('image/')) return 'IMAGE';
  if (mimeType.startsWith('video/')) return 'VIDEO';
  if (mimeType.startsWith('audio/')) return 'AUDIO';
  if (mimeType === 'application/pdf' || mimeType.startsWith('text/')) return 'DOCUMENT';
  return 'OTHER';
}

@Injectable()
export class MediaService {
  private readonly storage: S3ObjectStorageProvider;
  private readonly renderer: SharpImageRenderer;
  private bucketReady = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {
    this.storage = new S3ObjectStorageProvider(getApiEnv());
    this.renderer = new SharpImageRenderer({ storage: this.storage });
  }

  /** Honest capability descriptor for the UI. */
  status() {
    return {
      image: true,
      video: false,
      audio: false,
      htmlToImage: false,
      engine: this.renderer.id,
      // Spectra renders no video, but a video made elsewhere can be uploaded
      // and published (Phase 6F).
      upload: true,
    };
  }

  /**
   * Issues a short-lived signed URL the client PUTs the file straight to
   * object storage with (Phase 6F). Nothing is recorded yet: the asset row is
   * created only once storage confirms the object exists, so a ticket nobody
   * used leaves no trace of a file that is not there.
   */
  async createUploadTicket(tenant: TenantContext, input: MediaUploadTicketInput) {
    const mimeType = input.mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
    const check = validateUpload({ domain: 'media', mimeType, sizeBytes: input.sizeBytes });
    if (!check.ok) {
      if (check.reason === 'TOO_LARGE') throw new PayloadTooLargeException(check.message);
      throw new UnprocessableEntityException(check.message);
    }
    await this.ensureBucket();
    const uploadId = randomUUID();
    const key = buildObjectKey({
      ...this.scope(tenant),
      domain: 'media',
      resourceId: uploadId,
      filename: UPLOAD_FILENAME,
    });
    const signed = await this.storage.createSignedUploadUrl({
      key,
      contentType: mimeType,
      maxSizeBytes: input.sizeBytes,
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    });
    return {
      uploadId,
      uploadUrl: signed.url,
      method: 'PUT' as const,
      // The signature covers this header: the file must be sent with it.
      headers: { 'content-type': mimeType },
      expiresAt: signed.expiresAt.toISOString(),
    };
  }

  /**
   * Registers the uploaded object as a media asset. The size and type recorded
   * are the ones OBJECT STORAGE reports, never what the client claimed, and an
   * object that is not there is an honest 422 rather than an asset row
   * pointing at nothing. Completing twice returns the same asset.
   */
  async completeUpload(
    tenant: TenantContext,
    principal: Principal,
    input: MediaUploadCompleteInput,
  ) {
    const key = buildObjectKey({
      ...this.scope(tenant),
      domain: 'media',
      resourceId: input.uploadId,
      filename: UPLOAD_FILENAME,
    });
    const existing = await this.prisma.client.mediaAsset.findFirst({
      where: { ...this.scope(tenant), storageKey: key },
    });
    if (existing) return existing;

    const info = await this.storage.headObject(key);
    if (!info) {
      throw new UnprocessableEntityException(
        'No file was uploaded for this ticket. Upload the file to the signed URL first, then complete it.',
      );
    }
    const mimeType = info.contentType?.toLowerCase().split(';')[0]?.trim() ?? '';
    const check = validateUpload({ domain: 'media', mimeType, sizeBytes: info.sizeBytes });
    if (!check.ok) {
      // The stored object is not something this workspace may keep.
      await this.storage.deleteObject(key).catch(() => undefined);
      if (check.reason === 'TOO_LARGE') throw new PayloadTooLargeException(check.message);
      throw new UnprocessableEntityException(
        mimeType
          ? check.message
          : 'Object storage recorded no content type for the upload; send the file with the content-type header the ticket gave you.',
      );
    }

    const asset = await this.prisma.client.mediaAsset.create({
      data: {
        ...this.scope(tenant),
        kind: mediaKindFor(mimeType),
        storageKey: key,
        mimeType,
        sizeBytes: info.sizeBytes,
        createdById: principal.userId,
      },
    });
    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'media_asset.uploaded',
      resourceType: 'MediaAsset',
      resourceId: asset.id,
      changes: { kind: asset.kind, mimeType, sizeBytes: asset.sizeBytes },
    });
    return asset;
  }

  private scope(tenant: TenantContext) {
    return {
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId as string,
    };
  }

  list(tenant: TenantContext) {
    return this.prisma.client.mediaAsset.findMany({
      where: this.scope(tenant),
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  private async ensureBucket(): Promise<void> {
    if (!this.bucketReady) {
      await this.storage.ensureBucket();
      this.bucketReady = true;
    }
  }

  async processImage(tenant: TenantContext, principal: Principal, input: ProcessImageInput) {
    const source = Buffer.from(input.imageBase64, 'base64');
    if (source.length === 0) {
      throw new UnprocessableEntityException('The image data was empty or not valid base64.');
    }
    if (source.length > MAX_SOURCE_BYTES) {
      throw new PayloadTooLargeException('Source image exceeds the 10 MB limit.');
    }

    await this.ensureBucket();

    // Store the source, then render a derived asset from it.
    const sourceId = randomUUID();
    const sourceKey = buildObjectKey({
      ...this.scope(tenant),
      domain: 'media',
      resourceId: sourceId,
      filename: 'source.bin',
    });
    await this.storage.putObject({
      key: sourceKey,
      body: source,
      contentType: 'application/octet-stream',
    });
    const sourceAsset = await this.prisma.client.mediaAsset.create({
      data: {
        ...this.scope(tenant),
        kind: 'IMAGE',
        storageKey: sourceKey,
        mimeType: 'application/octet-stream',
        sizeBytes: source.length,
        createdById: principal.userId,
      },
    });

    let result;
    try {
      result = await this.renderer.render({
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        inputStorageKey: sourceKey,
        operations: input.operations,
        outputFormat: input.outputFormat,
      });
    } catch (error) {
      throw new UnprocessableEntityException(
        `Image could not be processed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    const asset = await this.prisma.client.mediaAsset.create({
      data: {
        id: result.asset.id,
        ...this.scope(tenant),
        kind: 'IMAGE',
        storageKey: result.asset.storageKey,
        mimeType: result.asset.mimeType,
        sizeBytes: result.asset.sizeBytes,
        widthPx: result.asset.widthPx ?? null,
        heightPx: result.asset.heightPx ?? null,
        sourceAssetId: sourceAsset.id,
        engine: result.engine,
        createdById: principal.userId,
      },
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: 'media_asset.rendered',
      resourceType: 'MediaAsset',
      resourceId: asset.id,
      changes: { engine: result.engine, format: input.outputFormat },
    });
    return asset;
  }

  /** Loads asset bytes for streaming; missing/foreign fail identically (404). */
  async getContent(
    tenant: TenantContext,
    id: string,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    const asset = await this.prisma.client.mediaAsset.findFirst({
      where: { id, ...this.scope(tenant) },
      select: { storageKey: true, mimeType: true },
    });
    if (!asset) throw new TenantIsolationError();
    const buffer = await this.storage.getObject(asset.storageKey);
    return { buffer, mimeType: asset.mimeType };
  }
}
