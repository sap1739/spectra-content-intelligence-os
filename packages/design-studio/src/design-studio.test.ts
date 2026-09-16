import {
  DESIGN_FORMATS,
  brandKitSchema,
  getDesignFormat,
  type BrandKit,
  type TemplateLayout,
} from '@spectra/contracts';
import sharp from 'sharp';
import { getDocumentProxy } from 'unpdf';
import { describe, expect, it } from 'vitest';

import { BUILT_IN_TEMPLATES, getBuiltInTemplate } from './builtins';
import { buildImagePdf } from './pdf';
import {
  DesignValidationError,
  NEUTRAL_PALETTE,
  buildRenderPlan,
  renderPlanHash,
  resolveTokens,
  validateTemplateLayout,
} from './template';

const LOGO = '11111111-1111-4111-8111-111111111111';
const PHOTO = '22222222-2222-4222-8222-222222222222';

const kit = (overrides: Partial<BrandKit> = {}): BrandKit =>
  brandKitSchema.parse({
    logoAssetId: LOGO,
    palette: {
      primary: '#0f766e',
      secondary: '#134e4a',
      accent: '#f59e0b',
      background: '#ffffff',
      text: '#0f172a',
    },
    typography: { heading: null, body: null },
    tagline: 'Roasted in small batches',
    offerings: [{ name: 'House Blend', description: 'Chocolate and cherry' }],
    ...overrides,
  });
const brand = (overrides: Partial<BrandKit> = {}) => ({
  name: 'Acme Coffee',
  websiteUrl: 'https://acme.coffee/',
  kit: kit(overrides),
});

function errorIssues(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (error instanceof DesignValidationError) return error.issues;
    throw error;
  }
  throw new Error('expected a DesignValidationError');
}

describe('formats', () => {
  it('include YouTube thumbnail dimensions and its documented 2 MB limit', () => {
    expect(getDesignFormat('YOUTUBE_THUMBNAIL')).toMatchObject({
      width: 1280,
      height: 720,
      maxBytes: 2 * 1024 * 1024,
    });
    expect(new Set(DESIGN_FORMATS.map((format) => format.key)).size).toBe(DESIGN_FORMATS.length);
    expect(getDesignFormat('INSTAGRAM_PORTRAIT')).toMatchObject({ width: 1080, height: 1350 });
  });
});

describe('template validation', () => {
  it('accepts every built-in template, each with formats that exist', () => {
    expect(BUILT_IN_TEMPLATES.length).toBeGreaterThanOrEqual(6);
    for (const template of BUILT_IN_TEMPLATES) {
      expect(() => validateTemplateLayout(template.layout), template.key).not.toThrow();
      expect(template.formats).toContain(template.defaultFormat);
      for (const key of template.formats) expect(getDesignFormat(key), key).toBeDefined();
    }
    expect(getBuiltInTemplate('tips-carousel')?.layout.pages).toHaveLength(3);
  });

  it('rejects references the schema cannot see: wrong field kinds, duplicates, unused fields', () => {
    const layout = structuredClone(getBuiltInTemplate('announcement')?.layout) as TemplateLayout;
    layout.fields.push({
      key: 'unused',
      label: 'Unused',
      kind: 'TEXT',
      required: false,
      maxLength: 10,
      defaultValue: null,
      help: null,
    });
    const page = layout.pages[0];
    if (!page) throw new Error('page');
    page.layers.push({
      type: 'image',
      id: 'bad',
      box: { x: 0, y: 0, w: 0.1, h: 0.1 },
      slot: 'headline',
      fit: 'cover',
    });
    page.layers.push({
      type: 'rect',
      id: 'band',
      box: { x: 0, y: 0, w: 0.1, h: 0.1 },
      fill: { hex: '#000000' },
      opacity: 1,
      radius: 0,
    });
    const messages = errorIssues(() => validateTemplateLayout(layout)).map(
      (issue) => issue.message,
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        '"headline" is not an IMAGE field.',
        'Duplicate layer id "band" on this page.',
        'Field "unused" is not used by any layer.',
      ]),
    );
  });

  it('rejects boxes outside the canvas, bad colours and markup-looking keys', () => {
    const issues = errorIssues(() =>
      validateTemplateLayout({
        schemaVersion: 1,
        fields: [{ key: '<script>', label: 'x', kind: 'TEXT' }],
        pages: [
          {
            id: 'p',
            background: { fill: { hex: 'red' } },
            layers: [
              {
                type: 'rect',
                id: 'r',
                box: { x: 0.8, y: 0, w: 0.5, h: 0.1 },
                fill: { brand: 'primary' },
              },
            ],
          },
        ],
      }),
    );
    const text = issues.map((issue) => `${issue.path} ${issue.message}`).join('\n');
    expect(text).toContain('field keys are camelCase');
    // A colour is a union (brand role or hex), so Zod reports the whole value as invalid.
    expect(text).toMatch(/pages\.0\.background\.fill /);
    expect(text).toContain('inside the canvas');
  });
});

describe('brand tokens', () => {
  it('fills brand and product tokens and reports what was missing', () => {
    expect(resolveTokens('Follow {{brand.name}} at {{ brand.website }}', brand())).toEqual({
      text: 'Follow Acme Coffee at acme.coffee',
      missing: [],
    });
    const none = resolveTokens('{{brand.tagline}}', { name: 'Acme', websiteUrl: null, kit: null });
    expect(none).toEqual({ text: '', missing: ['brand.tagline'] });
  });
});

describe('render plans', () => {
  const announcement = getBuiltInTemplate('announcement')?.layout as TemplateLayout;

  it('resolves brand colours, tokens, logo and pixel boxes', () => {
    const plan = buildRenderPlan({
      layout: announcement,
      formatKey: 'INSTAGRAM_PORTRAIT',
      brand: brand(),
      values: { headline: 'New autumn roast' },
      images: { photo: PHOTO },
    });
    const page = plan.pages[0];
    expect(plan.format).toMatchObject({ width: 1080, height: 1350 });
    expect(page?.backgroundImageAssetId).toBe(PHOTO);
    const subline = page?.ops.find((op) => op.kind === 'text' && op.layerId === 'sublineText');
    expect(subline).toMatchObject({ text: 'Roasted in small batches', color: '#FFFFFF' });
    const pill = page?.ops.find((op) => op.kind === 'rect' && op.color === '#F59E0B');
    expect(pill).toBeDefined();
    expect(page?.ops.find((op) => op.kind === 'image' && op.layerId === 'logo')).toMatchObject({
      assetId: LOGO,
      fit: 'contain',
    });
    expect(plan.assetIds.sort()).toEqual([LOGO, PHOTO].sort());
    expect(plan.warnings).toEqual([]);
  });

  it('refuses missing required fields, over-long text and unknown fields — all at once', () => {
    const issues = errorIssues(() =>
      buildRenderPlan({
        layout: announcement,
        formatKey: 'INSTAGRAM_PORTRAIT',
        brand: brand(),
        values: { cta: 'x'.repeat(31), nope: 'y' },
        images: {},
      }),
    );
    expect(issues.map((issue) => issue.path).sort()).toEqual([
      'values.cta',
      'values.headline',
      'values.nope',
    ]);
    expect(
      errorIssues(() =>
        buildRenderPlan({
          layout: announcement,
          formatKey: 'NOPE',
          brand: null,
          values: {},
          images: {},
        }),
      )[0]?.path,
    ).toBe('formatKey');
  });

  it('never pretends: missing brand colours, logo, tokens and images are each reported', () => {
    const plan = buildRenderPlan({
      layout: announcement,
      formatKey: 'INSTAGRAM_SQUARE',
      brand: {
        name: 'Acme',
        websiteUrl: null,
        kit: kit({
          logoAssetId: null,
          palette: {},
          tagline: null,
          typography: { heading: { family: 'Brand Sans', fontAssetId: null }, body: null },
        }),
      },
      values: { headline: 'Hello' },
      images: {},
    });
    const warnings = plan.warnings.join('\n');
    expect(warnings).toContain(
      `no secondary colour; Spectra’s neutral ${NEUTRAL_PALETTE.secondary}`,
    );
    expect(warnings).toContain('no logo');
    expect(warnings).toContain('{{brand.tagline}}');
    expect(warnings).toContain('"Brand Sans" has no uploaded font file');
    expect(plan.pages[0]?.backgroundImageAssetId).toBeNull();
    expect(
      buildRenderPlan({
        layout: announcement,
        formatKey: 'INSTAGRAM_SQUARE',
        brand: null,
        values: { headline: 'Hi' },
        images: {},
      }).warnings[0],
    ).toContain('No brand selected');
  });

  it('plans every carousel page and hashes identical inputs identically', () => {
    const layout = getBuiltInTemplate('tips-carousel')?.layout as TemplateLayout;
    const input = {
      layout,
      formatKey: 'INSTAGRAM_PORTRAIT',
      brand: brand(),
      values: { coverTitle: 'Brew better', tipTitle: 'Weigh your beans' },
      images: {},
    };
    const plan = buildRenderPlan(input);
    expect(plan.pages.map((page) => page.index)).toEqual([0, 1, 2]);
    const a = renderPlanHash(plan, { format: 'PNG', quality: 90 }, { [LOGO]: 'v1' });
    expect(
      renderPlanHash(buildRenderPlan(input), { format: 'PNG', quality: 90 }, { [LOGO]: 'v1' }),
    ).toBe(a);
    expect(renderPlanHash(plan, { format: 'JPEG', quality: 90 }, { [LOGO]: 'v1' })).not.toBe(a);
    expect(renderPlanHash(plan, { format: 'PNG', quality: 90 }, { [LOGO]: 'v2' })).not.toBe(a);
  });
});

describe('PDF export', () => {
  it('writes a PDF a real parser opens, one page per rendered image, sized from the dpi', async () => {
    const page = async (color: string) => ({
      jpeg: await sharp({ create: { width: 1240, height: 1754, channels: 3, background: color } })
        .jpeg()
        .toBuffer(),
      widthPx: 1240,
      heightPx: 1754,
    });
    const pdf = buildImagePdf([await page('#ff0000'), await page('#00ff00')], 150);
    expect(pdf.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    const document = await getDocumentProxy(new Uint8Array(pdf));
    expect(document.numPages).toBe(2);
    const first = await document.getPage(1);
    const [, , w, h] = first.view;
    // A4 at 150 dpi → 595 × 842 points.
    expect(Math.round(w as number)).toBe(595);
    expect(Math.round(h as number)).toBe(842);
    expect(() => buildImagePdf([], 72)).toThrow();
  });
});
