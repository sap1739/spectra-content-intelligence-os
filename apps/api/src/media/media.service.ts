import { randomUUID } from 'node:crypto';

import { Injectable, PayloadTooLargeException, UnprocessableEntityException } from '@nestjs/common';
import type { ProcessImageInput } from '@spectra/contracts';
import { SharpImageRenderer } from '@spectra/media-sharp';
import { TenantIsolationError } from '@spectra/security';
import { S3ObjectStorageProvider, buildObjectKey } from '@spectra/storage';

import { getApiEnv } from '../config/env';
import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal, TenantContext } from '../auth/types';

const MAX_SOURCE_BYTES = 10 * 1024 * 1024; // 10 MB decoded

/**
 * Media rendering. Image processing is REAL (sharp); video, audio and
 * HTML-to-image renderers are honestly reported as unavailable until their
 * engines (ffmpeg, headless chromium) are wired — the UI never implies they work.
 */
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
    };
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
