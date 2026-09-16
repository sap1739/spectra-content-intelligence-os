import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DesignPageRender, DesignRenderAssets, DesignRenderer } from '@spectra/media-core';
import type { RenderOp, RenderPlan } from '@spectra/design-studio';
import sharp from 'sharp';

/**
 * Real design rendering with sharp (ADR-0040): libvips composites, librsvg for
 * the shapes Spectra itself generates, and Pango for text — real word
 * wrapping, real font metrics, and uploaded TTF/OTF brand fonts.
 *
 * Inputs are a RenderPlan (already validated, pixel-resolved) and an asset
 * loader the caller has tenant-checked. Nothing is fetched from a URL, no
 * user-supplied markup is interpreted (text is escaped before it reaches
 * Pango; SVG is only ever Spectra's own rectangles), and every deviation from
 * the template — text shrunk or cut, an image that would not decode — is
 * returned as a warning rather than hidden.
 */

/** Refuse decompression bombs: 8K × 6K is far beyond any design input. */
const MAX_INPUT_PIXELS = 50_000_000;

export class DesignRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesignRenderError';
  }
}

function escapeMarkup(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function rgb(hex: string) {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

export class SharpDesignRenderer implements DesignRenderer {
  readonly id = 'sharp-design';
  readonly displayName = 'Sharp + Pango design renderer';
  readonly engineVersion: string = sharp.versions.sharp ?? 'unknown';

  private readonly fontDir: string;

  constructor(options: { fontCacheDir?: string } = {}) {
    this.fontDir = options.fontCacheDir ?? join(tmpdir(), 'spectra-design-fonts');
  }

  async renderPage(
    plan: RenderPlan,
    pageIndex: number,
    output: { format: 'png' | 'jpeg'; quality: number; maxWidth?: number | null },
    assets: DesignRenderAssets,
  ): Promise<DesignPageRender> {
    const started = Date.now();
    const page = plan.pages[pageIndex];
    if (!page) throw new DesignRenderError(`Page ${pageIndex + 1} does not exist.`);
    const { width, height } = plan.format;
    const warnings: string[] = [];
    const layers: sharp.OverlayOptions[] = [];

    if (page.backgroundImageAssetId) {
      const background = await this.image(
        assets,
        page.backgroundImageAssetId,
        width,
        height,
        'cover',
      );
      layers.push({ input: background, left: 0, top: 0 });
    }
    for (const op of page.ops) {
      const layer = await this.layer(op, pageIndex, assets, warnings);
      if (layer) layers.push(layer);
    }

    let pipeline = sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { ...rgb(page.backgroundColor), alpha: 1 },
      },
    }).composite(layers);

    // Composite first, then scale: a preview is the export, only smaller.
    if (output.maxWidth && output.maxWidth < width) {
      pipeline = sharp(await pipeline.png().toBuffer()).resize({ width: output.maxWidth });
    }

    let quality = output.quality;
    let buffer = await this.encode(pipeline, output.format, quality, page.backgroundColor);
    const limit = plan.format.maxBytes;
    if (limit && !output.maxWidth) {
      // A destination with a documented byte limit (YouTube: 2 MB): step JPEG
      // quality down rather than export a file the platform will refuse.
      while (buffer.length > limit && output.format === 'jpeg' && quality > 50) {
        quality -= 10;
        buffer = await this.encode(pipeline, 'jpeg', quality, page.backgroundColor);
      }
      if (buffer.length > limit) {
        warnings.push(
          `The ${output.format.toUpperCase()} is ${(buffer.length / 1048576).toFixed(2)} MB, over the ${(limit / 1048576).toFixed(0)} MB limit ${plan.format.label} documents${output.format === 'png' ? '; export JPEG instead' : ''}.`,
        );
      } else if (quality < output.quality) {
        warnings.push(
          `JPEG quality was lowered to ${quality} to stay within the ${(limit / 1048576).toFixed(0)} MB limit.`,
        );
      }
    }
    const meta = await sharp(buffer).metadata();
    return {
      buffer,
      mimeType: output.format === 'png' ? 'image/png' : 'image/jpeg',
      width: meta.width ?? 0,
      height: meta.height ?? 0,
      quality: output.format === 'jpeg' ? quality : null,
      warnings,
      durationMs: Date.now() - started,
    };
  }

  private async encode(
    pipeline: sharp.Sharp,
    format: 'png' | 'jpeg',
    quality: number,
    background: string,
  ) {
    const clone = pipeline.clone();
    return format === 'png'
      ? clone.png({ compressionLevel: 9 }).toBuffer()
      : clone
          .flatten({ background: rgb(background) })
          .jpeg({ quality, progressive: false, chromaSubsampling: '4:4:4' })
          .toBuffer();
  }

  private async layer(
    op: RenderOp,
    pageIndex: number,
    assets: DesignRenderAssets,
    warnings: string[],
  ): Promise<sharp.OverlayOptions | null> {
    switch (op.kind) {
      case 'rect': {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${op.w}" height="${op.h}"><rect x="0" y="0" width="${op.w}" height="${op.h}" rx="${op.radiusPx}" ry="${op.radiusPx}" fill="${op.color}" fill-opacity="${op.opacity}"/></svg>`;
        return { input: Buffer.from(svg), left: op.x, top: op.y };
      }
      case 'image': {
        const input = await this.image(assets, op.assetId, op.w, op.h, op.fit, () =>
          warnings.push(
            `Page ${pageIndex + 1}: an image in "${op.layerId}" could not be decoded and was skipped.`,
          ),
        );
        return input ? { input, left: op.x, top: op.y } : null;
      }
      case 'text':
        return this.text(op, pageIndex, assets, warnings);
    }
  }

  private async image(
    assets: DesignRenderAssets,
    assetId: string,
    width: number,
    height: number,
    fit: 'cover' | 'contain',
    onUnreadable?: () => void,
  ): Promise<Buffer> {
    const bytes = await assets.loadImage(assetId);
    try {
      return await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
        .rotate()
        .resize(width, height, { fit, background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .ensureAlpha()
        .png()
        .toBuffer();
    } catch {
      if (onUnreadable) {
        onUnreadable();
        return sharp({
          create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
        })
          .png()
          .toBuffer();
      }
      throw new DesignRenderError('A background image could not be decoded.');
    }
  }

  private async text(
    op: Extract<RenderOp, { kind: 'text' }>,
    pageIndex: number,
    assets: DesignRenderAssets,
    warnings: string[],
  ): Promise<sharp.OverlayOptions> {
    const fontfile = op.font.fontAssetId
      ? await this.fontFile(assets, op.font.fontAssetId)
      : undefined;
    const markup = `<span foreground="${op.color}"${op.weight === 'bold' ? ' font_weight="bold"' : ''}>${escapeMarkup(op.text)}</span>`;
    const base = {
      text: markup,
      font: `${op.font.family} ${op.sizePx}`,
      ...(fontfile ? { fontfile } : {}),
      width: op.w,
      align: op.align,
      rgba: true,
      wrap: 'word' as const,
      dpi: 72,
    };
    let rendered = await sharp({ text: base }).png().toBuffer({ resolveWithObject: true });
    if (rendered.info.height > op.h) {
      if (op.autofit) {
        // Pango fits the text to the box when a height is given; only ever
        // used to SHRINK text that did not fit at its designed size.
        // sharp takes either a dpi or a height: with a height it picks the dpi.
        const { dpi: _designedDpi, ...fit } = base;
        rendered = await sharp({ text: { ...fit, height: op.h } })
          .png()
          .toBuffer({ resolveWithObject: true });
        warnings.push(`Page ${pageIndex + 1}: text in "${op.layerId}" was shrunk to fit its box.`);
      } else {
        rendered = await sharp(rendered.data)
          .extract({ left: 0, top: 0, width: rendered.info.width, height: op.h })
          .png()
          .toBuffer({ resolveWithObject: true });
        warnings.push(
          `Page ${pageIndex + 1}: text in "${op.layerId}" is longer than its box and was cut off.`,
        );
      }
    }
    const textWidth = Math.min(rendered.info.width, op.w);
    const left =
      op.align === 'center'
        ? op.x + Math.floor((op.w - textWidth) / 2)
        : op.align === 'right'
          ? op.x + op.w - textWidth
          : op.x;
    const input =
      rendered.info.width > op.w
        ? await sharp(rendered.data)
            .extract({ left: 0, top: 0, width: op.w, height: rendered.info.height })
            .png()
            .toBuffer()
        : rendered.data;
    return { input, left, top: op.y };
  }

  /** Fonts are written once per content hash; Pango loads them from disk. */
  private async fontFile(assets: DesignRenderAssets, assetId: string): Promise<string> {
    const bytes = await assets.loadFont(assetId);
    const path = join(this.fontDir, `${createHash('sha256').update(bytes).digest('hex')}.ttf`);
    try {
      await stat(path);
    } catch {
      await mkdir(this.fontDir, { recursive: true });
      await writeFile(path, bytes, { mode: 0o600 });
    }
    return path;
  }
}
