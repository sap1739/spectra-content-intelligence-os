import { EncryptionError, decryptSecret, encryptSecret, type KeyRing } from '@spectra/security';
import { z } from 'zod';

/**
 * The credential a connection stores: ONE sealed JSON document holding the
 * access and refresh tokens (AES-256-GCM via @spectra/security). One secret
 * column per connection means nothing to keep in step. Expiry lives in plain
 * columns because it is not secret and must be queryable.
 */
export interface TokenBundle {
  accessToken: string;
  refreshToken: string | null;
  tokenType: string | null;
}

const bundleSchema = z.object({
  v: z.literal(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).nullable(),
  tokenType: z.string().nullable(),
});

/** Storing a token without the encryption key is refused — never written in the clear. */
export class CredentialStorageUnavailableError extends Error {
  constructor() {
    super(
      'Credential storage is not configured (SOCIAL_TOKEN_ENCRYPTION_KEY) — tokens cannot be stored',
    );
    this.name = 'CredentialStorageUnavailableError';
  }
}

export function sealTokenBundle(
  bundle: TokenBundle,
  ring: KeyRing | undefined,
): { sealed: string; keyId: string } {
  if (!ring) throw new CredentialStorageUnavailableError();
  const payload = JSON.stringify({
    v: 1,
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken,
    tokenType: bundle.tokenType,
  });
  return { sealed: encryptSecret(payload, ring), keyId: ring.activeKeyId };
}

export function openTokenBundle(sealed: string, ring: KeyRing | undefined): TokenBundle {
  if (!ring) throw new CredentialStorageUnavailableError();
  const plaintext = decryptSecret(sealed, ring);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new EncryptionError('Sealed credential is not a token bundle');
  }
  const result = bundleSchema.safeParse(parsed);
  if (!result.success) throw new EncryptionError('Sealed credential is not a token bundle');
  return {
    accessToken: result.data.accessToken,
    refreshToken: result.data.refreshToken,
    tokenType: result.data.tokenType,
  };
}
