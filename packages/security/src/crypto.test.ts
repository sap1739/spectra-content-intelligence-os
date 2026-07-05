import { describe, expect, it } from 'vitest';

import { EncryptionError } from './errors';
import { decryptSecret, encryptSecret, generateEncryptionKey, type KeyRing } from './crypto';

function ring(activeKeyId: string, keys: Record<string, string>): KeyRing {
  return { activeKeyId, keys };
}

describe('secret encryption', () => {
  const keyA = generateEncryptionKey();
  const keyB = generateEncryptionKey();

  it('round-trips a secret', () => {
    const r = ring('k1', { k1: keyA });
    const encrypted = encryptSecret('oauth-refresh-token-value', r);
    expect(encrypted).not.toContain('oauth-refresh-token-value');
    expect(decryptSecret(encrypted, r)).toBe('oauth-refresh-token-value');
  });

  it('produces unique ciphertexts for identical plaintexts (random IV)', () => {
    const r = ring('k1', { k1: keyA });
    expect(encryptSecret('same', r)).not.toBe(encryptSecret('same', r));
  });

  it('supports key rotation: old ciphertexts stay readable', () => {
    const oldRing = ring('k1', { k1: keyA });
    const encrypted = encryptSecret('legacy-secret', oldRing);
    const rotatedRing = ring('k2', { k1: keyA, k2: keyB });
    expect(decryptSecret(encrypted, rotatedRing)).toBe('legacy-secret');
    const reEncrypted = encryptSecret('legacy-secret', rotatedRing);
    expect(reEncrypted.split('.')[1]).toBe('k2');
  });

  it('fails closed on tampered ciphertext', () => {
    const r = ring('k1', { k1: keyA });
    const encrypted = encryptSecret('secret', r);
    const parts = encrypted.split('.');
    const flipped = parts[4]!.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
    const tampered = [...parts.slice(0, 4), flipped].join('.');
    expect(() => decryptSecret(tampered, r)).toThrow(EncryptionError);
  });

  it('fails on an unknown key id', () => {
    const encrypted = encryptSecret('secret', ring('k1', { k1: keyA }));
    expect(() => decryptSecret(encrypted, ring('k2', { k2: keyB }))).toThrow(EncryptionError);
  });
});
