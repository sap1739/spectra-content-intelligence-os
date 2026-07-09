import { randomUUID } from 'node:crypto';

import type {
  AspectRatioTarget,
  ImageOperation,
  ImageRenderSpec,
  MediaAssetRef,
  TenantScope,
} from '@spectra/contracts';
import type { ImageRenderer, RenderResult } from '@spectra/media-core';
import { type ObjectStorageProvider, buildObjectKey } from '@spectra/storage';
import sharp from 'sharp';

const FORMAT_MIME: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
};

const GRAVITY: Record<string, string> = {
  north: 'north',
  south: 'south',
  east: 'east',
  west: 'west',
  center: 'center',
  northeast: 'northeast',
  northwest: 'northwest',
  southeast: 'southeast',
  southwest: 'southwest',
};

export interface SharpRendererDeps {
  storage: ObjectStorageProvider;
  idFactory?: () => string;
  now?: () => Date;
}

/**
 * Real image processing via sharp. Reads the input from tenant-scoped storage,
 * applies the operation pipeline, and writes the derived asset under the
 * tenant-rooted `renders/` domain. This is the first media renderer wired for
 * real — video/audio renderers remain honestly unavailable until ffmpeg lands.
 */
export class SharpImageRenderer implements ImageRenderer {
  readonly id = 'sharp';
  readonly displayName = 'Sharp image renderer';

  private readonly storage: ObjectStorageProvider;
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(deps: SharpRendererDeps) {
    this.storage = deps.storage;
    this.idFactory = deps.idFactory ?? randomUUID;
    this.now = deps.now ?? (() => new Date());
  }

  async render(spec: ImageRenderSpec): Promise<RenderResult> {
    const startedAt = Date.now();
    const tenant: TenantScope = {
      organizationId: spec.organizationId,
      workspaceId: spec.workspaceId,
    };

    const input = await this.storage.getObject(spec.inputStorageKey);
    let pipeline = sharp(input, { failOn: 'none' });

    for (const op of spec.operations) {
      pipeline = await this.applyOperation(pipeline, op);
    }

    const format = spec.outputFormat;
    pipeline = pipeline.toFormat(format);
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

    const assetId = this.idFactory();
    const key = buildObjectKey({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      domain: 'renders',
      resourceId: assetId,
      filename: `image.${format}`,
    });
    const mimeType = FORMAT_MIME[format] ?? 'application/octet-stream';
    await this.storage.putObject({ key, body: data, contentType: mimeType });

    const asset: MediaAssetRef = {
      id: assetId,
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      kind: 'IMAGE',
      storageKey: key,
      mimeType,
      sizeBytes: info.size,
      widthPx: info.width,
      heightPx: info.height,
      createdAt: this.now().toISOString(),
    };

    return {
      asset,
      durationMs: Date.now() - startedAt,
      engine: this.id,
      engineVersion: sharp.versions.sharp,
    };
  }

  resize(
    tenant: TenantScope,
    inputStorageKey: string,
    width: number,
    height: number,
  ): Promise<RenderResult> {
    return this.render({
      ...tenant,
      inputStorageKey,
      operations: [{ kind: 'resize', width, height, fit: 'cover' }],
      outputFormat: 'webp',
    });
  }

  convertAspectRatio(
    tenant: TenantScope,
    inputStorageKey: string,
    target: AspectRatioTarget,
  ): Promise<RenderResult> {
    return this.render({
      ...tenant,
      inputStorageKey,
      operations: [{ kind: 'resize', width: target.width, height: target.height, fit: 'cover' }],
      outputFormat: 'webp',
    });
  }

  private async applyOperation(pipeline: sharp.Sharp, op: ImageOperation): Promise<sharp.Sharp> {
    switch (op.kind) {
      case 'resize':
        return pipeline.resize({
          ...(op.width ? { width: op.width } : {}),
          ...(op.height ? { height: op.height } : {}),
          fit: op.fit,
        });
      case 'crop':
        return pipeline.extract({
          left: op.left,
          top: op.top,
          width: op.width,
          height: op.height,
        });
      case 'rotate':
        return pipeline.rotate(op.degrees);
      case 'format':
        return pipeline.toFormat(op.format, op.quality ? { quality: op.quality } : {});
      case 'overlay': {
        const overlay = await this.storage.getObject(op.overlayStorageKey);
        return pipeline.composite([{ input: overlay, gravity: GRAVITY[op.gravity] }]);
      }
      default:
        return pipeline;
    }
  }
}
