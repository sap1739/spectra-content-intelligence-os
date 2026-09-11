import {
  EncryptionError,
  encryptSecret,
  generateEncryptionKey,
  needsReseal,
  type KeyRing,
} from '@spectra/security';
import { describe, expect, it } from 'vitest';

import { CredentialStorageUnavailableError, openTokenBundle, sealTokenBundle } from './bundle';

const ring = (activeKeyId: string, keys: Record<string, string>): KeyRing => ({
  activeKeyId,
  keys,
});
const keyA = generateEncryptionKey();
const keyB = generateEncryptionKey();
const bundle = {
  accessToken: 'access-token-value-1',
  refreshToken: 'refresh-token-value-1',
  tokenType: 'bearer',
};

describe('sealed token bundles', () => {
  it('seals both tokens into one ciphertext that contains neither', () => {
    const r = ring('social-v1', { 'social-v1': keyA });
    const { sealed, keyId } = sealTokenBundle(bundle, r);
    expect(keyId).toBe('social-v1');
    expect(sealed.startsWith('v1.social-v1.')).toBe(true);
    expect(sealed).not.toContain('access-token-value-1');
    expect(sealed).not.toContain('refresh-token-value-1');
    expect(openTokenBundle(sealed, r)).toEqual(bundle);
  });

  it('refuses to seal without an encryption key instead of storing tokens in the clear', () => {
    expect(() => sealTokenBundle(bundle, undefined)).toThrow(CredentialStorageUnavailableError);
  });

  it('refuses to open without an encryption key', () => {
    const { sealed } = sealTokenBundle(bundle, ring('k1', { k1: keyA }));
    expect(() => openTokenBundle(sealed, undefined)).toThrow(CredentialStorageUnavailableError);
  });

  it('fails closed under the wrong key', () => {
    const { sealed } = sealTokenBundle(bundle, ring('k1', { k1: keyA }));
    expect(() => openTokenBundle(sealed, ring('k1', { k1: keyB }))).toThrow(EncryptionError);
  });

  it('rejects a ciphertext that is not a token bundle, without echoing it', () => {
    const r = ring('k1', { k1: keyA });
    const raw = encryptSecret('wp-user:app-password-value', r);
    try {
      openTokenBundle(raw, r);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EncryptionError);
      expect((error as Error).message).not.toContain('app-password-value');
    }
  });

  it('stays readable across a key rotation and is flagged for re-sealing', () => {
    const { sealed } = sealTokenBundle(bundle, ring('social-v1', { 'social-v1': keyA }));
    const rotated = ring('social-v2', { 'social-v1': keyA, 'social-v2': keyB });
    expect(openTokenBundle(sealed, rotated)).toEqual(bundle);
    expect(needsReseal(sealed, rotated)).toBe(true);
    const resealed = sealTokenBundle(openTokenBundle(sealed, rotated), rotated);
    expect(resealed.keyId).toBe('social-v2');
    expect(needsReseal(resealed.sealed, rotated)).toBe(false);
  });
});
