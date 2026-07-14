import { Injectable } from '@nestjs/common';
import { type KeyRing, encryptSecret } from '@spectra/security';

import { getApiEnv } from '../config/env';

const SOCIAL_KEY_ID = 'social-v1';

/**
 * Seals social-account credentials with AES-256-GCM (@spectra/security).
 *
 * Env-gated: without SOCIAL_TOKEN_ENCRYPTION_KEY the service is UNCONFIGURED —
 * callers may still register accounts, but a request that supplies a credential
 * to store is honestly refused rather than persisting a token in the clear.
 * The key never leaves this service; sealed values are never returned by the API.
 */
@Injectable()
export class SocialCryptoService {
  private readonly ring: KeyRing | undefined;

  constructor() {
    const key = getApiEnv().SOCIAL_TOKEN_ENCRYPTION_KEY;
    this.ring = key ? { keys: { [SOCIAL_KEY_ID]: key }, activeKeyId: SOCIAL_KEY_ID } : undefined;
  }

  get isConfigured(): boolean {
    return this.ring !== undefined;
  }

  /** Encrypts a credential. Precondition: `isConfigured`. */
  seal(plaintext: string): string {
    if (!this.ring) {
      throw new Error('SocialCryptoService is not configured');
    }
    return encryptSecret(plaintext, this.ring);
  }
}
