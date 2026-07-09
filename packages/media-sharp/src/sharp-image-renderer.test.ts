import type { ObjectStorageProvider } from '@spectra/storage';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';

import { SharpImageRenderer } from './sharp-image-renderer';

const tenant = { organizationId: 'org-1', workspaceId: 'ws-1' };

/** In-memory storage double keyed by object key. */
function fakeStorage(seed: Record<string, Buffer>) {
  const store = new Map<string, Buffer>(Object.entries(seed));
  const signed = { url: 'http://x', expiresAt: new Date() };
  const provider: ObjectStorageProvider = {
    providerId: 'fake',
    ensureBucket: async () => undefined,
    putObject: async ({ key, body, contentType }) => {
      const buf = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
      store.set(key, buf);
      return { key, sizeBytes: buf.length, contentType };
    },
    getObject: async (key) => {
      const buf = store.get(key);
      if (!buf) throw new Error(`missing ${key}`);
      return buf;
    },
    headObject: async (key) => {
      const buf = store.get(key);
      return buf ? { key, sizeBytes: buf.length } : null;
    },
    deleteObject: async (key) => {
      store.delete(key);
    },
    createSignedUploadUrl: async () => signed,
    createSignedDownloadUrl: async () => signed,
  };
  return { provider, store };
}

let redPng: Buffer;

beforeAll(async () => {
  redPng = await sharp({
    create: { width: 200, height: 100, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .png()
    .toBuffer();
});

describe('SharpImageRenderer', () => {
  it('resizes an image, writes a tenant-rooted derived asset, and reports metadata', async () => {
    const { provider, store } = fakeStorage({ 'input.png': redPng });
    const renderer = new SharpImageRenderer({ storage: provider, idFactory: () => 'asset-1' });

    const result = await renderer.render({
      ...tenant,
      inputStorageKey: 'input.png',
      operations: [{ kind: 'resize', width: 50, height: 25, fit: 'fill' }],
      outputFormat: 'webp',
    });

    expect(result.engine).toBe('sharp');
    expect(result.asset.kind).toBe('IMAGE');
    expect(result.asset.mimeType).toBe('image/webp');
    expect(result.asset.widthPx).toBe(50);
    expect(result.asset.heightPx).toBe(25);
    // Written under the tenant-rooted renders domain.
    expect(result.asset.storageKey).toBe('org/org-1/ws/ws-1/renders/asset-1/image.webp');
    expect(store.has(result.asset.storageKey)).toBe(true);

    // The stored bytes are a real webp of the requested size.
    const meta = await sharp(store.get(result.asset.storageKey)!).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(50);
  });

  it('applies a format conversion to jpeg', async () => {
    const { provider } = fakeStorage({ 'input.png': redPng });
    const renderer = new SharpImageRenderer({ storage: provider, idFactory: () => 'a2' });
    const result = await renderer.render({
      ...tenant,
      inputStorageKey: 'input.png',
      operations: [{ kind: 'format', format: 'jpeg', quality: 80 }],
      outputFormat: 'jpeg',
    });
    expect(result.asset.mimeType).toBe('image/jpeg');
  });

  it('resize() convenience port produces a webp of the requested dimensions', async () => {
    const { provider } = fakeStorage({ 'input.png': redPng });
    const renderer = new SharpImageRenderer({ storage: provider, idFactory: () => 'a3' });
    const result = await renderer.resize(tenant, 'input.png', 32, 32);
    expect(result.asset.widthPx).toBe(32);
    expect(result.asset.mimeType).toBe('image/webp');
  });
});
