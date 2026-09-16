import { z } from 'zod';

import { uuidSchema } from './common';
import type { SocialPlatform } from './social';

/**
 * Visual design studio contracts (Phase 7A, ADR-0040).
 *
 * A template is layout DATA — normalized boxes, brand colour roles, text fields
 * and image slots — never code or markup. A design is one filled-in instance
 * of a template for one brand and one output size. Every export is a real
 * render (sharp/Pango, ADR-0018) stored as a media asset; nothing here
 * describes an image that was not actually produced.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const DESIGN_TEMPLATE_CATEGORIES = [
  'SOCIAL_POST',
  'CAROUSEL',
  'STORY',
  'THUMBNAIL',
  'FLYER',
  'POSTER',
  'BANNER',
  'QUOTE',
] as const;
export const designTemplateCategorySchema = z.enum(DESIGN_TEMPLATE_CATEGORIES);
export type DesignTemplateCategory = z.infer<typeof designTemplateCategorySchema>;

/** Draft → in review → approved → published (set when a post using an export publishes). */
export const DESIGN_STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'ARCHIVED'] as const;
export const designStatusSchema = z.enum(DESIGN_STATUSES);
export type DesignStatus = z.infer<typeof designStatusSchema>;

export const DESIGN_OUTPUT_FORMATS = ['PNG', 'JPEG', 'PDF'] as const;
export const designOutputFormatSchema = z.enum(DESIGN_OUTPUT_FORMATS);
export type DesignOutputFormat = z.infer<typeof designOutputFormatSchema>;

export const BRAND_COLOR_ROLES = ['primary', 'secondary', 'accent', 'background', 'text'] as const;
export const brandColorRoleSchema = z.enum(BRAND_COLOR_ROLES);
export type BrandColorRole = z.infer<typeof brandColorRoleSchema>;

export const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'must be a #RRGGBB colour')
  .transform((value) => value.toUpperCase());

// ---------------------------------------------------------------------------
// Output sizes
// ---------------------------------------------------------------------------

export interface DesignFormat {
  key: string;
  label: string;
  width: number;
  height: number;
  /** Rendering resolution the pixel size corresponds to (PDF page size uses it). */
  dpi: number;
  platform: SocialPlatform | null;
  /** What the size is, and where the number comes from. */
  note: string;
  /** A hard byte limit the destination enforces, when it documents one. */
  maxBytes: number | null;
}

const MB = 1024 * 1024;

/**
 * Output sizes. Platform sizes are the sizes each platform recommends in its
 * own guidance; they are presets, not limits — except where a byte limit is
 * documented (YouTube thumbnails: JPEG/PNG up to 2 MB, thumbnails.set).
 * Print sizes are ISO A4/A3 and US Letter at 150 dpi.
 */
export const DESIGN_FORMATS: readonly DesignFormat[] = [
  {
    key: 'INSTAGRAM_SQUARE',
    label: 'Instagram square (1:1)',
    width: 1080,
    height: 1080,
    dpi: 72,
    platform: 'INSTAGRAM',
    note: 'Square feed post.',
    maxBytes: null,
  },
  {
    key: 'INSTAGRAM_PORTRAIT',
    label: 'Instagram portrait (4:5)',
    width: 1080,
    height: 1350,
    dpi: 72,
    platform: 'INSTAGRAM',
    note: 'The tallest feed aspect ratio Instagram accepts for images (4:5).',
    maxBytes: null,
  },
  {
    key: 'STORY_VERTICAL',
    label: 'Story / vertical (9:16)',
    width: 1080,
    height: 1920,
    dpi: 72,
    platform: null,
    note: 'Full-screen vertical. Spectra does not publish stories; export and post it yourself.',
    maxBytes: null,
  },
  {
    key: 'FACEBOOK_POST',
    label: 'Facebook post (1.91:1)',
    width: 1200,
    height: 630,
    dpi: 72,
    platform: 'FACEBOOK',
    note: 'Landscape link/photo post.',
    maxBytes: null,
  },
  {
    key: 'LINKEDIN_POST',
    label: 'LinkedIn post (1.91:1)',
    width: 1200,
    height: 627,
    dpi: 72,
    platform: 'LINKEDIN',
    note: 'Landscape image post.',
    maxBytes: null,
  },
  {
    key: 'X_POST',
    label: 'X post (16:9)',
    width: 1600,
    height: 900,
    dpi: 72,
    platform: 'X',
    note: 'Landscape single image.',
    maxBytes: null,
  },
  {
    key: 'PINTEREST_PIN',
    label: 'Pinterest pin (2:3)',
    width: 1000,
    height: 1500,
    dpi: 72,
    platform: 'PINTEREST',
    note: 'Standard 2:3 pin.',
    maxBytes: null,
  },
  {
    key: 'YOUTUBE_THUMBNAIL',
    label: 'YouTube thumbnail (16:9)',
    width: 1280,
    height: 720,
    dpi: 72,
    platform: 'YOUTUBE',
    note: 'YouTube custom thumbnail size; thumbnails.set accepts JPEG or PNG up to 2 MB.',
    maxBytes: 2 * MB,
  },
  {
    key: 'FLYER_A4',
    label: 'Flyer A4 (150 dpi)',
    width: 1240,
    height: 1754,
    dpi: 150,
    platform: null,
    note: 'ISO A4 portrait at 150 dpi — good for screens and office printing.',
    maxBytes: null,
  },
  {
    key: 'POSTER_A3',
    label: 'Poster A3 (150 dpi)',
    width: 1754,
    height: 2480,
    dpi: 150,
    platform: null,
    note: 'ISO A3 portrait at 150 dpi. Commercial print usually wants 300 dpi; this is not print-shop resolution.',
    maxBytes: null,
  },
  {
    key: 'FLYER_LETTER',
    label: 'Flyer US Letter (150 dpi)',
    width: 1275,
    height: 1650,
    dpi: 150,
    platform: null,
    note: 'US Letter portrait at 150 dpi.',
    maxBytes: null,
  },
];

export const DESIGN_FORMAT_KEYS = DESIGN_FORMATS.map((format) => format.key) as [
  string,
  ...string[],
];
export const designFormatKeySchema = z.enum(DESIGN_FORMAT_KEYS);

export function getDesignFormat(key: string): DesignFormat | undefined {
  return DESIGN_FORMATS.find((format) => format.key === key);
}

// ---------------------------------------------------------------------------
// Brand kit
// ---------------------------------------------------------------------------

export const brandFontSchema = z.object({
  /** Font family name as the font file (or render host) knows it. */
  family: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9 _-]+$/, 'letters, digits, spaces, _ and - only'),
  /** An uploaded TTF/OTF media asset. Without one, the render host's installed fonts are used. */
  fontAssetId: uuidSchema.nullish(),
});
export type BrandFont = z.infer<typeof brandFontSchema>;

export const brandOfferingSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).default(''),
});

export const brandKitSchema = z.object({
  /** A PNG, JPEG or WebP media asset in this workspace. */
  logoAssetId: uuidSchema.nullable().default(null),
  palette: z.object(
    Object.fromEntries(
      BRAND_COLOR_ROLES.map((role) => [role, hexColorSchema.optional()]),
    ) as Record<BrandColorRole, z.ZodOptional<typeof hexColorSchema>>,
  ),
  typography: z.object({
    heading: brandFontSchema.nullish(),
    body: brandFontSchema.nullish(),
  }),
  tagline: z.string().max(200).nullish(),
  /** Visual style guidance in words (imagery, composition, what to avoid). */
  visualStyle: z.string().max(2000).nullish(),
  /** Products or services templates can reference ({{product.name}}). */
  offerings: z.array(brandOfferingSchema).max(20).default([]),
});
export type BrandKit = z.infer<typeof brandKitSchema>;

export const updateBrandKitInputSchema = brandKitSchema.partial();
export type UpdateBrandKitInput = z.infer<typeof updateBrandKitInputSchema>;

// ---------------------------------------------------------------------------
// Template layout
// ---------------------------------------------------------------------------

export const colorRefSchema = z.union([
  z.object({ brand: brandColorRoleSchema }).strict(),
  z.object({ hex: hexColorSchema }).strict(),
]);
export type ColorRef = z.infer<typeof colorRefSchema>;

const unit = z.number().finite().min(0).max(1);
/** A box in fractions of the canvas, so one layout adapts to every output size. */
export const layoutBoxSchema = z
  .object({
    x: unit,
    y: unit,
    w: unit.refine((v) => v > 0, 'width must be > 0'),
    h: unit.refine((v) => v > 0, 'height must be > 0'),
  })
  .strict()
  .refine((box) => box.x + box.w <= 1.0001 && box.y + box.h <= 1.0001, {
    message: 'box must stay inside the canvas',
  });
export type LayoutBox = z.infer<typeof layoutBoxSchema>;

const layerId = z.string().regex(/^[a-z][a-zA-Z0-9_-]{0,39}$/);
const fieldKey = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9_]{0,39}$/, 'field keys are camelCase letters and digits');

export const templateLayerSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('rect'),
      id: layerId,
      box: layoutBoxSchema,
      fill: colorRefSchema,
      opacity: z.number().min(0).max(1).default(1),
      /** Corner radius as a fraction of the box's shorter side (0–0.5). */
      radius: z.number().min(0).max(0.5).default(0),
    })
    .strict(),
  z
    .object({
      type: z.literal('text'),
      id: layerId,
      box: layoutBoxSchema,
      field: fieldKey,
      font: z.enum(['heading', 'body']).default('body'),
      /** Font size as a fraction of the canvas height. */
      sizeRatio: z.number().min(0.008).max(0.3),
      color: colorRefSchema,
      align: z.enum(['left', 'center', 'right']).default('left'),
      weight: z.enum(['normal', 'bold']).default('normal'),
      /** Shrink the text to fit the box instead of cutting it at the box edge. */
      autofit: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      type: z.literal('image'),
      id: layerId,
      box: layoutBoxSchema,
      slot: fieldKey,
      fit: z.enum(['cover', 'contain']).default('cover'),
    })
    .strict(),
  z
    .object({
      type: z.literal('logo'),
      id: layerId,
      box: layoutBoxSchema,
    })
    .strict(),
]);
export type TemplateLayer = z.infer<typeof templateLayerSchema>;

export const templateFieldSchema = z
  .object({
    key: fieldKey,
    label: z.string().min(1).max(80),
    kind: z.enum(['TEXT', 'IMAGE']),
    required: z.boolean().default(false),
    /** TEXT only. */
    maxLength: z.number().int().min(1).max(2000).default(280),
    /** TEXT only. May use {{brand.name}}, {{brand.tagline}}, {{brand.website}}, {{product.name}}, {{product.description}}. */
    defaultValue: z.string().max(2000).nullish(),
    help: z.string().max(200).nullish(),
  })
  .strict();
export type TemplateField = z.infer<typeof templateFieldSchema>;

export const templatePageSchema = z
  .object({
    id: layerId,
    background: z
      .object({
        fill: colorRefSchema,
        /** An IMAGE field drawn edge to edge behind every layer. */
        imageSlot: fieldKey.nullish(),
      })
      .strict(),
    layers: z.array(templateLayerSchema).max(40),
  })
  .strict();
export type TemplatePage = z.infer<typeof templatePageSchema>;

export const TEMPLATE_LAYOUT_SCHEMA_VERSION = 1;

export const templateLayoutSchema = z
  .object({
    schemaVersion: z.literal(TEMPLATE_LAYOUT_SCHEMA_VERSION),
    fields: z.array(templateFieldSchema).max(40),
    /** One page for a single image; several for a carousel (max 10). */
    pages: z.array(templatePageSchema).min(1).max(10),
  })
  .strict();
export type TemplateLayout = z.infer<typeof templateLayoutSchema>;

// ---------------------------------------------------------------------------
// API inputs
// ---------------------------------------------------------------------------

export const createDesignTemplateInputSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(1000).nullish(),
    category: designTemplateCategorySchema,
    formats: z.array(designFormatKeySchema).min(1).max(DESIGN_FORMATS.length),
    defaultFormat: designFormatKeySchema,
    /** Either a full layout, or a built-in template to copy. */
    layout: templateLayoutSchema.optional(),
    fromBuiltInKey: z.string().min(1).max(80).optional(),
  })
  .strict()
  .refine((input) => Boolean(input.layout) !== Boolean(input.fromBuiltInKey), {
    message: 'Provide exactly one of layout or fromBuiltInKey.',
  })
  .refine((input) => input.formats.includes(input.defaultFormat), {
    message: 'defaultFormat must be one of formats.',
  });
export type CreateDesignTemplateInput = z.infer<typeof createDesignTemplateInputSchema>;

export const updateDesignTemplateInputSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(1000).nullish(),
    category: designTemplateCategorySchema.optional(),
    formats: z.array(designFormatKeySchema).min(1).optional(),
    defaultFormat: designFormatKeySchema.optional(),
    layout: templateLayoutSchema.optional(),
  })
  .strict();
export type UpdateDesignTemplateInput = z.infer<typeof updateDesignTemplateInputSchema>;

export const designTemplateRefSchema = z.union([
  z.object({ builtInKey: z.string().min(1).max(80) }).strict(),
  z.object({ templateId: uuidSchema }).strict(),
]);

const designValuesSchema = z.record(fieldKey, z.string().max(2000));
const designImagesSchema = z.record(fieldKey, uuidSchema);

export const createDesignInputSchema = z
  .object({
    name: z.string().min(1).max(120),
    template: designTemplateRefSchema,
    brandId: uuidSchema.nullish(),
    formatKey: designFormatKeySchema,
    values: designValuesSchema.default({}),
    images: designImagesSchema.default({}),
    contentItemId: uuidSchema.nullish(),
    campaignId: uuidSchema.nullish(),
  })
  .strict();
export type CreateDesignInput = z.infer<typeof createDesignInputSchema>;

export const updateDesignInputSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    brandId: uuidSchema.nullish(),
    formatKey: designFormatKeySchema.optional(),
    values: designValuesSchema.optional(),
    images: designImagesSchema.optional(),
    contentItemId: uuidSchema.nullish(),
    campaignId: uuidSchema.nullish(),
  })
  .strict();
export type UpdateDesignInput = z.infer<typeof updateDesignInputSchema>;

export const exportDesignInputSchema = z
  .object({
    outputFormat: designOutputFormatSchema,
    /** JPEG quality (ignored for PNG); PDF pages are JPEG-encoded at this quality. */
    quality: z.number().int().min(40).max(100).default(90),
  })
  .strict();
export type ExportDesignInput = z.infer<typeof exportDesignInputSchema>;

export const designReviewInputSchema = z.object({ note: z.string().max(2000).nullish() }).strict();
export type DesignReviewInput = z.infer<typeof designReviewInputSchema>;
