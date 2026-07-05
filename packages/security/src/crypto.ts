import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { EncryptionError } from './errors';

/**
 * AES-256-GCM secret encryption with key-ring rotation, used for OAuth tokens
 * and other stored credentials.
 *
 * Ciphertext format: `v1.<keyId>.<iv>.<authTag>.<ciphertext>` (base64url parts).
 * Rotation: encrypt with `activeKeyId`; decrypt with whichever key the
 * ciphertext names, so old secrets stay readable until re-encrypted.
 * Keys come from a secret manager in production — never from source code.
 */

const FORMAT_VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;

export interface KeyRing {
  /** keyId → base64-encoded 32-byte key. */
  keys: Record<string, string>;
  activeKeyId: string;
}

function resolveKey(ring: KeyRing, keyId: string): Buffer {
  const encoded = ring.keys[keyId];
  if (!encoded) {
    throw new EncryptionError(`Unknown encryption key id: ${keyId}`);
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new EncryptionError(`Key ${keyId} must be ${KEY_LENGTH_BYTES} bytes`);
  }
  return key;
}

export function encryptSecret(plaintext: string, ring: KeyRing): string {
  const key = resolveKey(ring, ring.activeKeyId);
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    FORMAT_VERSION,
    ring.activeKeyId,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptSecret(payload: string, ring: KeyRing): string {
  const parts = payload.split('.');
  if (parts.length !== 5 || parts[0] !== FORMAT_VERSION) {
    throw new EncryptionError('Malformed encrypted payload');
  }
  const [, keyId, ivPart, tagPart, dataPart] = parts;
  const key = resolveKey(ring, keyId as string);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart as string, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart as string, 'base64url'));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart as string, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new EncryptionError('Decryption failed: authentication tag mismatch');
  }
}

/** Generates a new base64 key suitable for the key ring (dev/test tooling). */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_LENGTH_BYTES).toString('base64');
}
