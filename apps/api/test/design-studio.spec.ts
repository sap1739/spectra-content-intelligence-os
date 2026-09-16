import './setup-env';

import { randomBytes, randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { markDesignsPublished } from '@spectra/publishing';
import { S3ObjectStorageProvider, buildObjectKey } from '@spectra/storage';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase 7A: the design studio (ADR-0040), end to end against the real API,
 * Postgres and MinIO. Every assertion about an image is made by decoding the
 * bytes object storage holds — dimensions, formats, page counts — never by
 * trusting a response field.
 */

const runId = randomBytes(4).toString('hex');
const PASSWORD = 'integration-test-password-1';
const PRIMARY = '#0F766E';

interface Tenant {
  email: string;
  cookie: string;
  userId: string;
  orgId: string;
  workspaceId: string;
}

interface RenderBody {
  id: string;
  outputFormat: string;
  pageIndex: number | null;
  pageCount: number;
  widthPx: number;
  heightPx: number;
  warnings: string[];
  mediaAsset: { id: string; mimeType: string; sizeBytes: number };
}

function problemText(body: unknown): string {
  const problem = body as { title?: string; detail?: string };
  return `${problem.title ?? ''} ${problem.detail ?? ''}`;
}

describe('API integration: design studio (ADR-0040)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let storage: S3ObjectStorageProvider;
  const tenants: Tenant[] = [];
  const storedKeys: string[] = [];
  let owner: Tenant;
  let other: Tenant;
  let brandId = '';
  let logoId = '';
  let photoId = '';

  const inject = () => app.getHttpAdapter().getInstance();
  const studio = (t: Tenant = owner) => `/v1/workspaces/${t.workspaceId}/studio`;
  const get = (t: Tenant, url: string) =>
    inject().inject({ method: 'GET', url, headers: { cookie: t.cookie } });
  const send = (
    t: Tenant,
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
  ) =>
    inject().inject({
      method,
      url,
      headers: { cookie: t.cookie },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  async function registerTenant(label: string): Promise<Tenant> {
    const email = `studio-${label}-${runId}@itest.local`;
    const res = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD, name: `Studio ${label}` },
    });
    const raw = res.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0] as string;
    const me = res.json() as {
      user: { id: string };
      memberships: Array<{ organizationId: string }>;
      workspaces: Array<{ id: string }>;
    };
    const tenant = {
      email,
      cookie,
      userId: me.user.id,
      orgId: me.memberships[0]?.organizationId as string,
      workspaceId: me.workspaces[0]?.id as string,
    };
    tenants.push(tenant);
    return tenant;
  }

  async function storeAsset(t: Tenant, bytes: Buffer, mimeType: string, filename: string) {
    const id = randomUUID();
    const key = buildObjectKey({
      organizationId: t.orgId,
      workspaceId: t.workspaceId,
      domain: 'media',
      resourceId: id,
      filename,
    });
    await storage.putObject({ key, body: bytes, contentType: mimeType });
    storedKeys.push(key);
    await prisma.client.mediaAsset.create({
      data: {
        id,
        organizationId: t.orgId,
        workspaceId: t.workspaceId,
        kind: mimeType.startsWith('image/') ? 'IMAGE' : 'OTHER',
        storageKey: key,
        mimeType,
        sizeBytes: bytes.length,
      },
    });
    return id;
  }

  async function createDesign(t: Tenant, payload: Record<string, unknown>) {
    const res = await send(t, 'POST', `${studio(t)}/designs`, payload);
    return res;
  }

  async function exportDesign(
    t: Tenant,
    designId: string,
    outputFormat: 'PNG' | 'JPEG' | 'PDF',
    quality = 90,
  ) {
    return send(t, 'POST', `${studio(t)}/designs/${designId}/exports`, { outputFormat, quality });
  }

  async function storedBytes(render: RenderBody) {
    const asset = await prisma.client.mediaAsset.findFirstOrThrow({
      where: { organizationId: owner.orgId, id: render.mediaAsset.id },
    });
    return { asset, bytes: await storage.getObject(asset.storageKey) };
  }

  beforeAll(async () => {
    app = await createApp(getApiEnv());
    await app.init();
    await inject().ready();
    prisma = app.get(PrismaService);
    storage = new S3ObjectStorageProvider(getApiEnv());
    await storage.ensureBucket();
    owner = await registerTenant('owner');
    other = await registerTenant('other');

    logoId = await storeAsset(
      owner,
      await sharp({ create: { width: 400, height: 200, channels: 4, background: '#F59E0BFF' } })
        .png()
        .toBuffer(),
      'image/png',
      'logo.png',
    );
    photoId = await storeAsset(
      owner,
      await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#DC2626' } })
        .jpeg()
        .toBuffer(),
      'image/jpeg',
      'photo.jpg',
    );

    const brand = await send(owner, 'POST', `/v1/workspaces/${owner.workspaceId}/brands`, {
      name: `Acme Coffee ${runId}`,
      websiteUrl: 'https://acme.coffee',
    });
    expect(brand.statusCode).toBe(201);
    brandId = (brand.json() as { id: string }).id;
  });

  afterAll(async () => {
    const renders = await prisma.client.mediaAsset.findMany({
      where: { organizationId: { in: tenants.map((t) => t.orgId) } },
      select: { storageKey: true },
    });
    for (const key of [...storedKeys, ...renders.map((r) => r.storageKey)]) {
      await storage.deleteObject(key).catch(() => undefined);
    }
    for (const tenant of tenants) {
      await prisma.client.organization
        .deleteMany({ where: { id: tenant.orgId } })
        .catch(() => undefined);
      await prisma.client.user
        .deleteMany({ where: { email: tenant.email } })
        .catch(() => undefined);
    }
    await app.close();
  });

  describe('capabilities, formats and templates', () => {
    it('states what the renderer is, including that nothing is AI-generated', async () => {
      const caps = (await get(owner, `${studio()}/capabilities`)).json() as {
        engine: string;
        aiImageGeneration: boolean;
        outputs: string[];
      };
      expect(caps).toMatchObject({
        engine: 'sharp-design',
        aiImageGeneration: false,
        outputs: ['PNG', 'JPEG', 'PDF'],
      });
      const formats = (await get(owner, `${studio()}/formats`)).json() as Array<{
        key: string;
        width: number;
        height: number;
      }>;
      expect(formats.find((f) => f.key === 'YOUTUBE_THUMBNAIL')).toMatchObject({
        width: 1280,
        height: 720,
      });
      const templates = (await get(owner, `${studio()}/templates`)).json() as {
        builtIn: Array<{ key: string }>;
        workspace: unknown[];
      };
      expect(templates.builtIn.map((t) => t.key)).toEqual(
        expect.arrayContaining([
          'quote-card',
          'announcement',
          'tips-carousel',
          'youtube-thumbnail',
          'event-flyer',
          'product-spotlight',
        ]),
      );
      expect(templates.workspace).toEqual([]);
    });

    it('validates template layouts, copies built-ins, and versions edits', async () => {
      const bad = await send(owner, 'POST', `${studio()}/templates`, {
        name: 'Broken',
        category: 'SOCIAL_POST',
        formats: ['INSTAGRAM_SQUARE'],
        defaultFormat: 'INSTAGRAM_SQUARE',
        layout: {
          schemaVersion: 1,
          fields: [{ key: 'title', label: 'Title', kind: 'IMAGE' }],
          pages: [
            {
              id: 'p1',
              background: { fill: { brand: 'primary' } },
              layers: [
                {
                  type: 'text',
                  id: 't',
                  box: { x: 0, y: 0, w: 1, h: 0.2 },
                  field: 'title',
                  sizeRatio: 0.05,
                  color: { hex: '#FFFFFF' },
                },
              ],
            },
          ],
        },
      });
      expect(bad.statusCode).toBe(422);
      expect(problemText(bad.json())).toContain('"title" is not a TEXT field');

      const copy = await send(owner, 'POST', `${studio()}/templates`, {
        name: 'Our quote card',
        category: 'QUOTE',
        formats: ['INSTAGRAM_SQUARE'],
        defaultFormat: 'INSTAGRAM_SQUARE',
        fromBuiltInKey: 'quote-card',
      });
      expect(copy.statusCode).toBe(201);
      const template = copy.json() as {
        id: string;
        version: number;
        layout: { pages: Array<{ layers: Array<{ id: string; sizeRatio?: number }> }> };
      };
      expect(template.version).toBe(1);
      const layout = template.layout as unknown as Record<string, unknown> & {
        pages: Array<{ layers: Array<Record<string, unknown>> }>;
      };
      const quoteLayer = layout.pages[0]?.layers.find((layer) => layer.id === 'quoteText');
      if (quoteLayer) quoteLayer.sizeRatio = 0.07;
      const updated = await send(owner, 'PATCH', `${studio()}/templates/${template.id}`, {
        layout,
      });
      expect(updated.statusCode).toBe(200);
      expect((updated.json() as { version: number }).version).toBe(2);
      expect((await get(other, `${studio(other)}/templates/${template.id}`)).statusCode).toBe(404);
    });
  });

  describe('brand kit', () => {
    it('accepts this workspace’s raster logo, refuses SVG, fonts that are not fonts, and another tenant’s file', async () => {
      const svgId = await storeAsset(
        owner,
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        'image/svg+xml',
        'logo.svg',
      );
      const foreignLogo = await storeAsset(
        other,
        await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } })
          .png()
          .toBuffer(),
        'image/png',
        'x.png',
      );
      const kitUrl = `/v1/workspaces/${owner.workspaceId}/brands/${brandId}/kit`;
      expect((await send(owner, 'PUT', kitUrl, { logoAssetId: svgId })).statusCode).toBe(422);
      expect((await send(owner, 'PUT', kitUrl, { logoAssetId: foreignLogo })).statusCode).toBe(422);
      expect(
        (
          await send(owner, 'PUT', kitUrl, {
            typography: { heading: { family: 'Brand Sans', fontAssetId: photoId } },
          })
        ).statusCode,
      ).toBe(422);
      const ok = await send(owner, 'PUT', kitUrl, {
        logoAssetId: logoId,
        palette: {
          primary: PRIMARY.toLowerCase(),
          secondary: '#134E4A',
          accent: '#F59E0B',
          background: '#FFFFFF',
          text: '#0F172A',
        },
        typography: {},
        tagline: 'Roasted in small batches',
        visualStyle: 'Warm, natural light; no stock handshakes.',
        offerings: [{ name: 'House Blend', description: 'Chocolate and cherry' }],
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({
        logoAssetId: logoId,
        palette: { primary: PRIMARY },
        tagline: 'Roasted in small batches',
      });
      // Another tenant cannot touch this brand at all.
      expect(
        (
          await send(other, 'PUT', `/v1/workspaces/${other.workspaceId}/brands/${brandId}/kit`, {
            tagline: 'x',
          })
        ).statusCode,
      ).toBe(404);
    });
  });

  describe('designs, previews and exports', () => {
    let quoteId = '';

    it('refuses missing required fields, a size the template is not for, and foreign images', async () => {
      const missing = await createDesign(owner, {
        name: 'Q',
        template: { builtInKey: 'quote-card' },
        brandId,
        formatKey: 'INSTAGRAM_SQUARE',
        values: {},
      });
      expect(missing.statusCode).toBe(422);
      expect(problemText(missing.json())).toContain('"Quote" is required');
      const wrongSize = await createDesign(owner, {
        name: 'Q',
        template: { builtInKey: 'quote-card' },
        brandId,
        formatKey: 'YOUTUBE_THUMBNAIL',
        values: { quote: 'x' },
      });
      expect(wrongSize.statusCode).toBe(422);
      const foreignPhoto = await storeAsset(
        other,
        await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } })
          .jpeg()
          .toBuffer(),
        'image/jpeg',
        'x.jpg',
      );
      const foreign = await createDesign(owner, {
        name: 'A',
        template: { builtInKey: 'announcement' },
        brandId,
        formatKey: 'INSTAGRAM_PORTRAIT',
        values: { headline: 'Hi' },
        images: { photo: foreignPhoto },
      });
      expect(foreign.statusCode).toBe(422);
      expect(problemText(foreign.json())).toContain('not a media asset in this workspace');
      expect(
        (
          await createDesign(owner, {
            name: 'Q',
            template: { builtInKey: 'quote-card' },
            brandId: randomUUID(),
            formatKey: 'INSTAGRAM_SQUARE',
            values: { quote: 'x' },
          })
        ).statusCode,
      ).toBe(404);
    });

    it('previews a real render and exports a PNG into tenant-rooted storage', async () => {
      const created = await createDesign(owner, {
        name: 'Morning quote',
        template: { builtInKey: 'quote-card' },
        brandId,
        formatKey: 'INSTAGRAM_SQUARE',
        values: { quote: 'Good coffee is a small daily luxury worth protecting.' },
      });
      expect(created.statusCode).toBe(201);
      quoteId = (created.json() as { id: string }).id;

      const preview = await get(owner, `${studio()}/designs/${quoteId}/preview`);
      expect(preview.statusCode).toBe(200);
      expect(preview.headers['content-type']).toBe('image/png');
      const previewMeta = await sharp(preview.rawPayload).metadata();
      expect([previewMeta.width, previewMeta.height]).toEqual([720, 720]);

      const exported = await exportDesign(owner, quoteId, 'PNG');
      expect(exported.statusCode).toBe(201);
      const body = exported.json() as { reused: boolean; renders: RenderBody[] };
      expect(body.reused).toBe(false);
      expect(body.renders).toHaveLength(1);
      const { asset, bytes } = await storedBytes(body.renders[0] as RenderBody);
      expect(
        asset.storageKey.startsWith(`org/${owner.orgId}/ws/${owner.workspaceId}/renders/`),
      ).toBe(true);
      expect(asset).toMatchObject({
        mimeType: 'image/png',
        engine: 'sharp-design',
        widthPx: 1080,
        heightPx: 1080,
        kind: 'IMAGE',
      });
      const meta = await sharp(bytes).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['png', 1080, 1080]);
      // The brand primary, rendered — not described.
      const { data } = await sharp(bytes)
        .extract({ left: 2, top: 2, width: 1, height: 1 })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect([...data]).toEqual([0x0f, 0x76, 0x6e]);
      // It is a normal media asset, listed in the media library.
      const media = (
        await get(owner, `/v1/workspaces/${owner.workspaceId}/media`)
      ).json() as Array<{ id: string }>;
      expect(media.map((m) => m.id)).toContain(asset.id);
      // Metered as local rendering.
      const usage = await prisma.client.usageEvent.findFirst({
        where: { organizationId: owner.orgId, kind: 'MEDIA_RENDER', resourceId: quoteId },
      });
      // Local rendering is counted, not priced: a counter-only kind never
      // pretends to a cost, and never to a zero cost either.
      expect(usage).toMatchObject({
        provider: 'sharp',
        requests: 1,
        estimatedCostMicros: null,
        unpricedReason: 'COUNTER_ONLY',
      });
    });

    it('exporting unchanged inputs again returns the same files; a signed URL serves them', async () => {
      const before = await prisma.client.designRender.count({
        where: { organizationId: owner.orgId, designId: quoteId },
      });
      const again = (await exportDesign(owner, quoteId, 'PNG')).json() as {
        reused: boolean;
        renders: RenderBody[];
      };
      expect(again.reused).toBe(true);
      expect(
        await prisma.client.designRender.count({
          where: { organizationId: owner.orgId, designId: quoteId },
        }),
      ).toBe(before);

      const url = await get(owner, `${studio()}/renders/${again.renders[0]?.id}/url`);
      expect(url.statusCode).toBe(200);
      const signed = url.json() as { url: string; expiresAt: string };
      expect(new Date(signed.expiresAt).getTime()).toBeGreaterThan(Date.now());
      const fetched = await fetch(signed.url);
      expect(fetched.status).toBe(200);
      const meta = await sharp(Buffer.from(await fetched.arrayBuffer())).metadata();
      expect(meta.width).toBe(1080);
    });

    it('renders every carousel page, and a PDF holding all of them', async () => {
      const created = await createDesign(owner, {
        name: 'Brewing tips',
        template: { builtInKey: 'tips-carousel' },
        brandId,
        formatKey: 'INSTAGRAM_PORTRAIT',
        values: {
          coverTitle: 'Brew better at home',
          tipTitle: 'Weigh your beans',
          tipBody: 'Use 60 g of coffee per litre of water.',
        },
      });
      const designId = (created.json() as { id: string }).id;
      const pages = (await exportDesign(owner, designId, 'PNG')).json() as {
        renders: RenderBody[];
      };
      expect(pages.renders.map((r) => r.pageIndex)).toEqual([0, 1, 2]);
      for (const render of pages.renders) {
        const meta = await sharp((await storedBytes(render)).bytes).metadata();
        expect([meta.width, meta.height]).toEqual([1080, 1350]);
      }
      const pdf = (await exportDesign(owner, designId, 'PDF')).json() as { renders: RenderBody[] };
      expect(pdf.renders).toHaveLength(1);
      expect(pdf.renders[0]).toMatchObject({ outputFormat: 'PDF', pageIndex: null, pageCount: 3 });
      const { asset, bytes } = await storedBytes(pdf.renders[0] as RenderBody);
      expect(asset).toMatchObject({ mimeType: 'application/pdf', kind: 'DOCUMENT' });
      const text = bytes.toString('latin1');
      expect(text.startsWith('%PDF-1.4')).toBe(true);
      expect(text).toContain('/Count 3');
      expect(text.match(/\/Type \/Page /g)).toHaveLength(3);
    });

    it('exports a YouTube thumbnail at 1280×720 within YouTube’s 2 MB limit', async () => {
      const created = await createDesign(owner, {
        name: 'Episode 12',
        template: { builtInKey: 'youtube-thumbnail' },
        brandId,
        formatKey: 'YOUTUBE_THUMBNAIL',
        values: { title: 'Cupping 101' },
        images: { still: photoId },
      });
      expect(created.statusCode).toBe(201);
      const designId = (created.json() as { id: string }).id;
      const jpeg = (await exportDesign(owner, designId, 'JPEG', 95)).json() as {
        renders: RenderBody[];
      };
      const { bytes } = await storedBytes(jpeg.renders[0] as RenderBody);
      const meta = await sharp(bytes).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 1280, 720]);
      expect(bytes.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    });

    it('a MEDIA_RENDER limit of zero refuses the export before anything is rendered or stored', async () => {
      const created = await createDesign(owner, {
        name: 'Blocked',
        template: { builtInKey: 'quote-card' },
        brandId,
        formatKey: 'LINKEDIN_POST',
        values: { quote: 'Not today.' },
      });
      const designId = (created.json() as { id: string }).id;
      await prisma.client.budgetOperationLimit.create({
        data: {
          organizationId: owner.orgId,
          workspaceId: owner.workspaceId,
          kind: 'MEDIA_RENDER',
          maxRequests: 0,
        },
      });
      try {
        const refused = await exportDesign(owner, designId, 'PNG');
        expect(refused.statusCode).toBe(403);
        expect((refused.json() as { type: string }).type).toContain('budget-exceeded');
        expect(
          await prisma.client.designRender.count({
            where: { organizationId: owner.orgId, designId },
          }),
        ).toBe(0);
      } finally {
        await prisma.client.budgetOperationLimit.deleteMany({
          where: { organizationId: owner.orgId, kind: 'MEDIA_RENDER' },
        });
      }
    });
  });

  describe('workflow', () => {
    it('draft → review → approved; only approved exports can be scheduled; publishing marks it published', async () => {
      const item = await prisma.client.contentItem.create({
        data: {
          organizationId: owner.orgId,
          workspaceId: owner.workspaceId,
          title: 'Autumn launch',
          contentType: 'POST',
          lifecycleState: 'APPROVED',
        },
      });
      const campaign = await prisma.client.campaign.create({
        data: { organizationId: owner.orgId, workspaceId: owner.workspaceId, name: 'Autumn' },
      });
      const created = await createDesign(owner, {
        name: 'Launch post',
        template: { builtInKey: 'announcement' },
        brandId,
        formatKey: 'INSTAGRAM_PORTRAIT',
        values: { headline: 'The autumn roast is here' },
        images: { photo: photoId },
        contentItemId: item.id,
        campaignId: campaign.id,
      });
      expect(created.statusCode).toBe(201);
      const designId = (created.json() as { id: string }).id;
      const listed = (
        await get(owner, `${studio()}/designs?campaignId=${campaign.id}`)
      ).json() as Array<{ id: string }>;
      expect(listed.map((d) => d.id)).toEqual([designId]);

      // Reviewers approve rendered files, so there must be one.
      expect((await send(owner, 'POST', `${studio()}/designs/${designId}/submit`)).statusCode).toBe(
        422,
      );
      const exported = (await exportDesign(owner, designId, 'JPEG')).json() as {
        renders: RenderBody[];
      };
      const assetId = exported.renders[0]?.mediaAsset.id as string;

      const schedule = () =>
        send(owner, 'POST', `/v1/workspaces/${owner.workspaceId}/calendar`, {
          contentItemId: item.id,
          platform: 'INSTAGRAM',
          scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
          mediaAssetId: assetId,
        });
      const early = await schedule();
      expect(early.statusCode).toBe(422);
      expect(problemText(early.json())).toContain('Approve the design before scheduling it');

      expect(
        (await send(owner, 'POST', `${studio()}/designs/${designId}/submit`)).json(),
      ).toMatchObject({ status: 'IN_REVIEW' });
      expect(
        (
          await send(owner, 'POST', `${studio()}/designs/${designId}/approve`, {
            note: 'Looks right',
          })
        ).json(),
      ).toMatchObject({ status: 'APPROVED' });
      const scheduled = await schedule();
      expect(scheduled.statusCode).toBe(201);

      // Editing the visuals of an approved design sends it back to draft.
      const edited = (
        await send(owner, 'PATCH', `${studio()}/designs/${designId}`, {
          values: { headline: 'Changed' },
        })
      ).json() as { status: string; reviewNote: string };
      expect(edited.status).toBe('DRAFT');
      expect(edited.reviewNote).toContain('needs approval again');
      await prisma.client.design.updateMany({
        where: { organizationId: owner.orgId, id: designId },
        data: { status: 'APPROVED' },
      });

      expect(
        await markDesignsPublished(
          prisma.client,
          { organizationId: other.orgId, workspaceId: other.workspaceId },
          [assetId],
          new Date(),
        ),
      ).toBe(0);
      expect(
        await markDesignsPublished(
          prisma.client,
          { organizationId: owner.orgId, workspaceId: owner.workspaceId },
          [assetId],
          new Date(),
        ),
      ).toBe(1);
      expect((await get(owner, `${studio()}/designs/${designId}`)).json()).toMatchObject({
        status: 'PUBLISHED',
      });
    });
  });

  describe('tenant isolation and permissions', () => {
    it('another tenant’s design, preview, export and render URL are the same 404 as missing ones', async () => {
      const design = await prisma.client.design.findFirstOrThrow({
        where: { organizationId: owner.orgId },
      });
      const render = await prisma.client.designRender.findFirstOrThrow({
        where: { organizationId: owner.orgId },
      });
      const foreign = await get(other, `${studio(other)}/designs/${design.id}`);
      const missing = await get(other, `${studio(other)}/designs/${randomUUID()}`);
      expect(foreign.statusCode).toBe(404);
      expect(problemText(foreign.json())).toBe(problemText(missing.json()));
      expect((await get(other, `${studio(other)}/designs/${design.id}/preview`)).statusCode).toBe(
        404,
      );
      expect((await exportDesign(other, design.id, 'PNG')).statusCode).toBe(404);
      expect((await get(other, `${studio(other)}/renders/${render.id}/url`)).statusCode).toBe(404);
      const list = (await get(other, `${studio(other)}/designs`)).json() as unknown[];
      expect(list).toEqual([]);
    });

    it('design:read reads, design:write creates and exports, content:approve approves', async () => {
      const design = await prisma.client.design.findFirstOrThrow({
        where: { organizationId: owner.orgId, name: 'Morning quote' },
      });
      await prisma.client.membership.create({
        data: {
          organizationId: owner.orgId,
          userId: other.userId,
          role: 'READ_ONLY',
          status: 'ACTIVE',
        },
      });
      const asOther = { ...owner, cookie: other.cookie };
      try {
        expect((await get(asOther, `${studio()}/templates`)).statusCode).toBe(200);
        expect((await get(asOther, `${studio()}/designs/${design.id}/preview`)).statusCode).toBe(
          200,
        );
        const denied = await exportDesign(asOther, design.id, 'PNG');
        expect(denied.statusCode).toBe(403);
        expect(problemText(denied.json())).toContain('design:write');

        await prisma.client.membership.updateMany({
          where: { organizationId: owner.orgId, userId: other.userId },
          data: { role: 'CREATOR' },
        });
        const created = await createDesign(asOther, {
          name: 'By a creator',
          template: { builtInKey: 'quote-card' },
          formatKey: 'X_POST',
          values: { quote: 'Hello' },
        });
        expect(created.statusCode).toBe(201);
        const designId = (created.json() as { id: string }).id;
        expect((await exportDesign(asOther, designId, 'PNG')).statusCode).toBe(201);
        expect(
          (await send(asOther, 'POST', `${studio()}/designs/${designId}/submit`)).statusCode,
        ).toBe(201);
        const approve = await send(asOther, 'POST', `${studio()}/designs/${designId}/approve`, {});
        expect(approve.statusCode).toBe(403);
        expect(problemText(approve.json())).toContain('content:approve');

        await prisma.client.membership.updateMany({
          where: { organizationId: owner.orgId, userId: other.userId },
          data: { role: 'CLIENT_REVIEWER' },
        });
        expect((await get(asOther, `${studio()}/designs`)).statusCode).toBe(200);
        expect(
          (
            await send(asOther, 'POST', `${studio()}/templates`, {
              name: 'x',
              category: 'QUOTE',
              formats: ['X_POST'],
              defaultFormat: 'X_POST',
              fromBuiltInKey: 'quote-card',
            })
          ).statusCode,
        ).toBe(403);
      } finally {
        await prisma.client.membership.deleteMany({
          where: { organizationId: owner.orgId, userId: other.userId },
        });
      }
    });
  });
});
