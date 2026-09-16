import { createHash } from 'node:crypto';

import {
  BRAND_COLOR_ROLES,
  getDesignFormat,
  templateLayoutSchema,
  type BrandColorRole,
  type BrandKit,
  type ColorRef,
  type DesignFormat,
  type LayoutBox,
  type TemplateField,
  type TemplateLayout,
} from '@spectra/contracts';

/**
 * Template validation, brand-token resolution and render planning (ADR-0040).
 *
 * A render plan is the complete, pixel-resolved description of what the
 * renderer draws: every value is decided here — colours from the brand kit,
 * text with its tokens filled in, boxes in pixels — so rendering is a pure
 * function of the plan, and two identical plans render identically.
 */

export interface TemplateIssue {
  path: string;
  message: string;
}

export class DesignValidationError extends Error {
  constructor(public readonly issues: TemplateIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
    this.name = 'DesignValidationError';
  }
}

/**
 * Structural validation (the Zod schema) plus the rules a schema cannot see:
 * unique field keys and layer ids, every text layer pointing at a TEXT field,
 * every image slot at an IMAGE field, and no field that nothing uses.
 */
export function validateTemplateLayout(input: unknown): TemplateLayout {
  const parsed = templateLayoutSchema.safeParse(input);
  if (!parsed.success) {
    throw new DesignValidationError(
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || 'layout',
        message: issue.message,
      })),
    );
  }
  const layout = parsed.data;
  const issues: TemplateIssue[] = [];
  const fields = new Map<string, TemplateField>();
  layout.fields.forEach((field, index) => {
    if (fields.has(field.key))
      issues.push({ path: `fields.${index}.key`, message: `Duplicate field "${field.key}".` });
    fields.set(field.key, field);
    if (field.kind === 'IMAGE' && field.defaultValue) {
      issues.push({
        path: `fields.${index}.defaultValue`,
        message: 'Image fields cannot have a text default.',
      });
    }
  });

  const used = new Set<string>();
  const pageIds = new Set<string>();
  layout.pages.forEach((page, pageIndex) => {
    if (pageIds.has(page.id))
      issues.push({ path: `pages.${pageIndex}.id`, message: `Duplicate page id "${page.id}".` });
    pageIds.add(page.id);
    const layerIds = new Set<string>();
    const slot = page.background.imageSlot;
    if (slot) {
      used.add(slot);
      if (fields.get(slot)?.kind !== 'IMAGE') {
        issues.push({
          path: `pages.${pageIndex}.background.imageSlot`,
          message: `"${slot}" is not an IMAGE field.`,
        });
      }
    }
    page.layers.forEach((layer, layerIndex) => {
      const path = `pages.${pageIndex}.layers.${layerIndex}`;
      if (layerIds.has(layer.id))
        issues.push({
          path: `${path}.id`,
          message: `Duplicate layer id "${layer.id}" on this page.`,
        });
      layerIds.add(layer.id);
      if (layer.type === 'text') {
        used.add(layer.field);
        if (fields.get(layer.field)?.kind !== 'TEXT') {
          issues.push({ path: `${path}.field`, message: `"${layer.field}" is not a TEXT field.` });
        }
      }
      if (layer.type === 'image') {
        used.add(layer.slot);
        if (fields.get(layer.slot)?.kind !== 'IMAGE') {
          issues.push({ path: `${path}.slot`, message: `"${layer.slot}" is not an IMAGE field.` });
        }
      }
    });
  });
  layout.fields.forEach((field, index) => {
    if (!used.has(field.key)) {
      issues.push({
        path: `fields.${index}.key`,
        message: `Field "${field.key}" is not used by any layer.`,
      });
    }
  });
  if (issues.length > 0) throw new DesignValidationError(issues);
  return layout;
}

// ---------------------------------------------------------------------------
// Brand tokens
// ---------------------------------------------------------------------------

export interface BrandContext {
  name: string | null;
  websiteUrl: string | null;
  kit: BrandKit | null;
}

const TOKEN =
  /\{\{\s*(brand\.name|brand\.tagline|brand\.website|product\.name|product\.description)\s*\}\}/g;

/** Fills {{brand.*}} and {{product.*}} tokens; says which ones had nothing to fill. */
export function resolveTokens(
  text: string,
  brand: BrandContext | null,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const product = brand?.kit?.offerings[0] ?? null;
  const values: Record<string, string | null | undefined> = {
    'brand.name': brand?.name,
    'brand.tagline': brand?.kit?.tagline,
    'brand.website': brand?.websiteUrl
      ? brand.websiteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
      : null,
    'product.name': product?.name,
    'product.description': product?.description,
  };
  const resolved = text.replace(TOKEN, (_match, token: string) => {
    const value = values[token];
    if (!value) {
      missing.push(token);
      return '';
    }
    return value;
  });
  return { text: resolved.trim(), missing };
}

// ---------------------------------------------------------------------------
// Render plan
// ---------------------------------------------------------------------------

/** Used only where a brand has no colour for a role — and every use is reported. */
export const NEUTRAL_PALETTE: Readonly<Record<BrandColorRole, string>> = {
  primary: '#1F2937',
  secondary: '#4B5563',
  accent: '#2563EB',
  background: '#FFFFFF',
  text: '#111827',
};

export interface FontPlan {
  family: string;
  /** An uploaded font file to load; null means the render host's installed fonts. */
  fontAssetId: string | null;
}

export type RenderOp =
  | {
      kind: 'rect';
      x: number;
      y: number;
      w: number;
      h: number;
      color: string;
      opacity: number;
      radiusPx: number;
    }
  | {
      kind: 'text';
      layerId: string;
      x: number;
      y: number;
      w: number;
      h: number;
      text: string;
      font: FontPlan;
      sizePx: number;
      color: string;
      align: 'left' | 'center' | 'right';
      weight: 'normal' | 'bold';
      autofit: boolean;
    }
  | {
      kind: 'image';
      layerId: string;
      x: number;
      y: number;
      w: number;
      h: number;
      assetId: string;
      fit: 'cover' | 'contain';
    };

export interface PagePlan {
  index: number;
  backgroundColor: string;
  backgroundImageAssetId: string | null;
  ops: RenderOp[];
}

export interface RenderPlan {
  format: DesignFormat;
  pages: PagePlan[];
  /** Everything the render did differently from the template's intent, in words. */
  warnings: string[];
  /** Every media asset the render reads (images, logo, fonts) — the caller checks tenancy. */
  assetIds: string[];
}

export interface PlanInput {
  layout: TemplateLayout;
  formatKey: string;
  brand: BrandContext | null;
  values: Record<string, string>;
  images: Record<string, string>;
}

function px(box: LayoutBox, format: DesignFormat) {
  const x = Math.round(box.x * format.width);
  const y = Math.round(box.y * format.height);
  return {
    x,
    y,
    w: Math.max(1, Math.min(format.width - x, Math.round(box.w * format.width))),
    h: Math.max(1, Math.min(format.height - y, Math.round(box.h * format.height))),
  };
}

/**
 * Resolves a design into a render plan, or throws DesignValidationError with
 * every problem at once: an unknown format, a missing required field, text
 * over its limit, a value for a field the template does not have.
 */
export function buildRenderPlan(input: PlanInput): RenderPlan {
  const issues: TemplateIssue[] = [];
  const warnings: string[] = [];
  const format = getDesignFormat(input.formatKey);
  if (!format) {
    throw new DesignValidationError([
      { path: 'formatKey', message: `Unknown format "${input.formatKey}".` },
    ]);
  }
  const fields = new Map(input.layout.fields.map((field) => [field.key, field]));
  for (const key of Object.keys(input.values)) {
    if (fields.get(key)?.kind !== 'TEXT')
      issues.push({ path: `values.${key}`, message: 'Not a text field of this template.' });
  }
  for (const key of Object.keys(input.images)) {
    if (fields.get(key)?.kind !== 'IMAGE')
      issues.push({ path: `images.${key}`, message: 'Not an image field of this template.' });
  }

  const missingTokens = new Set<string>();
  const text = new Map<string, string>();
  for (const field of input.layout.fields) {
    if (field.kind === 'TEXT') {
      const raw = input.values[field.key] ?? field.defaultValue ?? '';
      const resolved = resolveTokens(raw, input.brand);
      resolved.missing.forEach((token) => missingTokens.add(token));
      if (field.required && !resolved.text) {
        issues.push({ path: `values.${field.key}`, message: `"${field.label}" is required.` });
      }
      if (resolved.text.length > field.maxLength) {
        issues.push({
          path: `values.${field.key}`,
          message: `"${field.label}" is longer than ${field.maxLength} characters.`,
        });
      }
      text.set(field.key, resolved.text);
    } else if (field.required && !input.images[field.key]) {
      issues.push({ path: `images.${field.key}`, message: `"${field.label}" needs an image.` });
    }
  }
  if (issues.length > 0) throw new DesignValidationError(issues);

  if (!input.brand)
    warnings.push(
      'No brand selected: Spectra’s neutral colours and the host’s default fonts were used.',
    );
  for (const token of missingTokens) {
    warnings.push(`The brand has no value for {{${token}}}, so that text was left empty.`);
  }

  const reportedRoles = new Set<BrandColorRole>();
  const color = (ref: ColorRef): string => {
    if ('hex' in ref) return ref.hex;
    const value = input.brand?.kit?.palette[ref.brand];
    if (value) return value;
    if (input.brand && !reportedRoles.has(ref.brand)) {
      reportedRoles.add(ref.brand);
      warnings.push(
        `The brand has no ${ref.brand} colour; Spectra’s neutral ${NEUTRAL_PALETTE[ref.brand]} was used.`,
      );
    }
    return NEUTRAL_PALETTE[ref.brand];
  };
  const font = (role: 'heading' | 'body'): FontPlan => {
    const configured = input.brand?.kit?.typography[role];
    return configured
      ? { family: configured.family, fontAssetId: configured.fontAssetId ?? null }
      : { family: 'sans-serif', fontAssetId: null };
  };

  const assetIds = new Set<string>();
  let logoWarned = false;
  const pages: PagePlan[] = input.layout.pages.map((page, index) => {
    const ops: RenderOp[] = [];
    const backgroundSlot = page.background.imageSlot;
    const backgroundImage = backgroundSlot ? (input.images[backgroundSlot] ?? null) : null;
    if (backgroundImage) assetIds.add(backgroundImage);
    for (const layer of page.layers) {
      const box = px(layer.box, format);
      switch (layer.type) {
        case 'rect':
          ops.push({
            kind: 'rect',
            ...box,
            color: color(layer.fill),
            opacity: layer.opacity,
            radiusPx: Math.round(layer.radius * Math.min(box.w, box.h)),
          });
          break;
        case 'text': {
          const value = text.get(layer.field) ?? '';
          if (!value) break;
          const plan = font(layer.font);
          if (plan.fontAssetId) assetIds.add(plan.fontAssetId);
          ops.push({
            kind: 'text',
            layerId: layer.id,
            ...box,
            text: value,
            font: plan,
            sizePx: Math.max(6, Math.round(layer.sizeRatio * format.height)),
            color: color(layer.color),
            align: layer.align,
            weight: layer.weight,
            autofit: layer.autofit,
          });
          break;
        }
        case 'image': {
          const assetId = input.images[layer.slot];
          if (!assetId) {
            warnings.push(
              `Page ${index + 1}: the "${fields.get(layer.slot)?.label ?? layer.slot}" image is empty, so nothing was drawn there.`,
            );
            break;
          }
          assetIds.add(assetId);
          ops.push({ kind: 'image', layerId: layer.id, ...box, assetId, fit: layer.fit });
          break;
        }
        case 'logo': {
          const logo = input.brand?.kit?.logoAssetId ?? null;
          if (!logo) {
            if (!logoWarned)
              warnings.push('The brand has no logo, so logo placeholders were left empty.');
            logoWarned = true;
            break;
          }
          assetIds.add(logo);
          ops.push({ kind: 'image', layerId: layer.id, ...box, assetId: logo, fit: 'contain' });
          break;
        }
      }
    }
    return {
      index,
      backgroundColor: color(page.background.fill),
      backgroundImageAssetId: backgroundImage,
      ops,
    };
  });

  for (const role of ['heading', 'body'] as const) {
    const configured = input.brand?.kit?.typography[role];
    if (configured && !configured.fontAssetId) {
      warnings.push(
        `The ${role} font "${configured.family}" has no uploaded font file, so it renders only if the render host has it installed; otherwise the host’s fallback font is used.`,
      );
    }
  }
  return { format, pages, warnings: [...new Set(warnings)], assetIds: [...assetIds] };
}

/** A stable hash of everything that decides the pixels, for idempotent exports. */
export function renderPlanHash(
  plan: RenderPlan,
  output: { format: string; quality: number },
  assetVersions: Record<string, string>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        v: 1,
        format: plan.format.key,
        pages: plan.pages,
        output,
        assets: Object.entries(assetVersions).sort(([a], [b]) => a.localeCompare(b)),
      }),
    )
    .digest('hex');
}

export { BRAND_COLOR_ROLES };
