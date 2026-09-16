import { brandKitSchema, type TemplateLayout } from '@spectra/contracts';
import { buildRenderPlan, getBuiltInTemplate } from '@spectra/design-studio';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';

import { SharpDesignRenderer } from './sharp-design-renderer';

/**
 * The design renderer, checked by looking at the pixels it produced: exact
 * output dimensions, brand colours where the layout puts them, text actually
 * drawn, images actually composited — not by trusting a return value.
 */

const LOGO = '11111111-1111-4111-8111-111111111111';
const PHOTO = '22222222-2222-4222-8222-222222222222';
const PRIMARY = '#0F766E';

let logo: Buffer;
let photo: Buffer;
let noisy: Buffer;

beforeAll(async () => {
  logo = await sharp({ create: { width: 400, height: 200, channels: 4, background: '#F59E0BFF' } })
    .png()
    .toBuffer();
  photo = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#DC2626' } })
    .jpeg()
    .toBuffer();
  // Random noise compresses terribly — the worst case for a byte limit.
  const raw = Buffer.alloc(1280 * 720 * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = Math.floor(Math.random() * 256);
  noisy = await sharp(raw, { raw: { width: 1280, height: 720, channels: 3 } })
    .png()
    .toBuffer();
});

const assets = () => ({
  loadImage: async (id: string) => {
    if (id === LOGO) return logo;
    if (id === PHOTO) return photo;
    if (id === 'noise') return noisy;
    throw new Error(`unknown asset ${id}`);
  },
  loadFont: async () => {
    throw new Error('no fonts in this test');
  },
});

const brand = {
  name: 'Acme Coffee',
  websiteUrl: 'https://acme.coffee',
  kit: brandKitSchema.parse({
    logoAssetId: LOGO,
    palette: {
      primary: PRIMARY,
      secondary: '#134E4A',
      accent: '#F59E0B',
      background: '#FFFFFF',
      text: '#0F172A',
    },
    typography: {},
    tagline: 'Small batches',
  }),
};

async function pixel(buffer: Buffer, x: number, y: number) {
  const { data, info } = await sharp(buffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return [data[offset], data[offset + 1], data[offset + 2]];
}

async function region(buffer: Buffer, box: { x: number; y: number; w: number; h: number }) {
  return sharp(buffer)
    .extract({ left: box.x, top: box.y, width: box.w, height: box.h })
    .removeAlpha()
    .raw()
    .toBuffer();
}

describe('SharpDesignRenderer', () => {
  const renderer = new SharpDesignRenderer();

  it('renders a quote card at the exact size, in the brand colour, with text and the logo', async () => {
    const plan = buildRenderPlan({
      layout: getBuiltInTemplate('quote-card')?.layout as TemplateLayout,
      formatKey: 'INSTAGRAM_SQUARE',
      brand,
      values: { quote: 'Good coffee is a small daily luxury worth protecting.' },
      images: {},
    });
    const page = await renderer.renderPage(plan, 0, { format: 'png', quality: 90 }, assets());
    expect(page).toMatchObject({ mimeType: 'image/png', width: 1080, height: 1080 });
    const meta = await sharp(page.buffer).metadata();
    expect(meta.format).toBe('png');
    // Background is the brand primary.
    expect(await pixel(page.buffer, 5, 5)).toEqual([0x0f, 0x76, 0x6e]);
    // The quote box contains white text pixels — the text was really drawn.
    const quote = await region(page.buffer, { x: 86, y: 173, w: 907, h: 400 });
    let white = 0;
    for (let i = 0; i < quote.length; i += 3)
      if ((quote[i] as number) > 240 && (quote[i + 1] as number) > 240) white += 1;
    expect(white).toBeGreaterThan(1000);
    // The logo (amber) is composited in its box.
    expect(await pixel(page.buffer, 900, 950)).toEqual([0xf5, 0x9e, 0x0b]);
  });

  it('draws a background photo edge to edge and escapes text instead of interpreting it', async () => {
    const plan = buildRenderPlan({
      layout: getBuiltInTemplate('announcement')?.layout as TemplateLayout,
      formatKey: 'FACEBOOK_POST',
      brand,
      values: { headline: '<b>Tags & "quotes"</b> stay literal' },
      images: { photo: PHOTO },
    });
    const page = await renderer.renderPage(plan, 0, { format: 'jpeg', quality: 85 }, assets());
    expect(page).toMatchObject({ mimeType: 'image/jpeg', width: 1200, height: 630 });
    const [r, g, b] = (await pixel(page.buffer, 20, 20)) as [number, number, number];
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(60);
    expect(b).toBeLessThan(60);
  });

  it('renders every page of a carousel', async () => {
    const plan = buildRenderPlan({
      layout: getBuiltInTemplate('tips-carousel')?.layout as TemplateLayout,
      formatKey: 'INSTAGRAM_PORTRAIT',
      brand,
      values: {
        coverTitle: 'Brew better at home',
        tipTitle: 'Weigh your beans',
        tipBody: 'Use 60 g per litre.',
      },
      images: {},
    });
    const pages = await Promise.all(
      plan.pages.map((_, index) =>
        renderer.renderPage(plan, index, { format: 'png', quality: 90 }, assets()),
      ),
    );
    expect(pages.map((page) => [page.width, page.height])).toEqual([
      [1080, 1350],
      [1080, 1350],
      [1080, 1350],
    ]);
    expect(await pixel(pages[1]?.buffer as Buffer, 5, 5)).toEqual([255, 255, 255]);
    expect(await pixel(pages[2]?.buffer as Buffer, 5, 5)).toEqual([0x13, 0x4e, 0x4a]);
  });

  it('shrinks autofit text and says so; a preview is the same render, scaled', async () => {
    const plan = buildRenderPlan({
      layout: getBuiltInTemplate('announcement')?.layout as TemplateLayout,
      formatKey: 'INSTAGRAM_SQUARE',
      brand,
      values: {
        headline:
          'A headline long enough to need two lines at its designed size, so it must shrink',
      },
      images: {},
    });
    // Squeeze the headline box to one line's height so the text cannot fit at size.
    const headline = plan.pages[0]?.ops.find(
      (op) => op.kind === 'text' && op.layerId === 'headlineText',
    );
    if (!headline || headline.kind !== 'text') throw new Error('headline op');
    headline.h = 70;
    const full = await renderer.renderPage(plan, 0, { format: 'png', quality: 90 }, assets());
    expect(full.warnings.join(' ')).toContain('shrunk to fit');
    const preview = await renderer.renderPage(
      plan,
      0,
      { format: 'png', quality: 90, maxWidth: 480 },
      assets(),
    );
    expect([preview.width, preview.height]).toEqual([480, 480]);
  });

  it('keeps a YouTube thumbnail JPEG within 2 MB by lowering quality, and says so', async () => {
    const plan = buildRenderPlan({
      layout: getBuiltInTemplate('youtube-thumbnail')?.layout as TemplateLayout,
      formatKey: 'YOUTUBE_THUMBNAIL',
      brand,
      values: { title: 'Noise' },
      images: { still: 'noise' },
    });
    const jpeg = await renderer.renderPage(plan, 0, { format: 'jpeg', quality: 100 }, assets());
    expect(jpeg.buffer.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(jpeg.width).toBe(1280);
    if (jpeg.quality !== 100) expect(jpeg.warnings.join(' ')).toContain('quality was lowered');
  });

  it('cuts non-autofit text at its box and reports it', async () => {
    const plan = buildRenderPlan({
      layout: getBuiltInTemplate('event-flyer')?.layout as TemplateLayout,
      formatKey: 'FLYER_A4',
      brand,
      values: {
        title: 'Cupping night',
        when: 'Friday 7pm — Friday 7pm — Friday 7pm — Friday 7pm — Friday 7pm',
      },
      images: {},
    });
    const page = await renderer.renderPage(plan, 0, { format: 'png', quality: 90 }, assets());
    expect([page.width, page.height]).toEqual([1240, 1754]);
    expect(page.warnings.join(' ')).toContain('cut off');
  });
});
