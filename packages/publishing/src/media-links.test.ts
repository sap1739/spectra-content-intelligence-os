import { buildObjectKey } from '@spectra/storage';
import { describe, expect, it } from 'vitest';

import { createMediaUrlSigner, publicMediaLinkProblem } from './resolver';

const ORG = '0b8e7f5c-1d2a-4c3b-9e8f-0a1b2c3d4e5f';
const WS = '1c9f8e6d-2e3b-4d4c-8f9e-1b2c3d4e5f60';
const OTHER = '2d0a9f7e-3f4c-4e5d-9a0f-2c3d4e5f6071';

describe('publicMediaLinkProblem', () => {
  it.each([
    'http://localhost:9000',
    'http://127.0.0.1:9000',
    'http://minio:9000',
    'http://10.0.0.5',
    'http://192.168.1.10:9000',
    'http://172.20.0.3:9000',
    'http://storage.internal',
    'http://[::1]:9000',
  ])('refuses %s — Instagram cannot reach it', (endpoint) => {
    expect(publicMediaLinkProblem(endpoint)).toMatch(/local or private address/);
  });

  it.each([
    'https://s3.us-east-1.amazonaws.com',
    'https://storage.example.com',
    'https://203.0.113.10',
  ])('accepts %s', (endpoint) => {
    expect(publicMediaLinkProblem(endpoint)).toBeNull();
  });
});

describe('createMediaUrlSigner', () => {
  const storage = {
    createSignedDownloadUrl: async (key: string, ttl?: number) => ({
      url: `https://storage.example.com/${key}?ttl=${ttl}`,
      expiresAt: new Date(),
    }),
  };

  it('signs a short-lived link to a key inside the tenant', async () => {
    const key = buildObjectKey({
      organizationId: ORG,
      workspaceId: WS,
      domain: 'media',
      resourceId: 'a1',
      filename: 'photo.jpg',
    });
    const url = await createMediaUrlSigner(storage)(
      { storageKey: key },
      { organizationId: ORG, workspaceId: WS },
    );
    expect(url).toBe(`https://storage.example.com/${key}?ttl=900`);
  });

  it('refuses a key from another tenant', async () => {
    const key = buildObjectKey({
      organizationId: OTHER,
      workspaceId: WS,
      domain: 'media',
      resourceId: 'a1',
      filename: 'photo.jpg',
    });
    await expect(
      createMediaUrlSigner(storage)({ storageKey: key }, { organizationId: ORG, workspaceId: WS }),
    ).rejects.toThrow();
  });
});
