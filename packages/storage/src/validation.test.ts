import { describe, expect, it } from 'vitest';

import { validateUpload } from './validation';

describe('validateUpload', () => {
  it('accepts an allowed document upload', () => {
    expect(
      validateUpload({ domain: 'documents', mimeType: 'application/pdf', sizeBytes: 1024 }),
    ).toEqual({ ok: true });
  });

  it('normalizes MIME parameters before checking', () => {
    expect(
      validateUpload({
        domain: 'documents',
        mimeType: 'text/plain; charset=utf-8',
        sizeBytes: 10,
      }).ok,
    ).toBe(true);
  });

  it('rejects disallowed MIME types', () => {
    const result = validateUpload({
      domain: 'documents',
      mimeType: 'application/x-msdownload',
      sizeBytes: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('MIME_NOT_ALLOWED');
  });

  it('rejects oversized and empty uploads', () => {
    const tooLarge = validateUpload({
      domain: 'webhooks',
      mimeType: 'application/json',
      sizeBytes: 100 * 1024 * 1024,
    });
    expect(tooLarge.ok).toBe(false);
    if (!tooLarge.ok) expect(tooLarge.reason).toBe('TOO_LARGE');

    const empty = validateUpload({ domain: 'media', mimeType: 'image/png', sizeBytes: 0 });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toBe('EMPTY');
  });
});
