import { Injectable } from '@nestjs/common';
import { socialKeyRingFromEnv } from '@spectra/config';
import { type KeyRing, decryptSecret, encryptSecret } from '@spectra/security';

import { getApiEnv } from '../config/env';

/**
 * Seals social-account credentials with AES-256-GCM (@spectra/security).
 *
 * Env-gated: without SOCIAL_TOKEN_ENCRYPTION_KEY the service is UNCONFIGURED —
 * callers may still register accounts, but a request that would store a
 * credential is honestly refused rather than persisting a token in the clear.
 *
 * Rotation (ADR-0034): the ring holds the active key plus any retired keys
 * (SOCIAL_TOKEN_ENCRYPTION_RETIRED_KEYS). New ciphertexts use the active key;
 * older ones stay readable and move onto the active key the next time they are
 * written. The key never leaves this service; sealed values are never returned
 * by the API.
 */
@Injectable()
export class SocialCryptoService {
  private readonly ring: KeyRing | undefined;

  constructor() {
    this.ring = socialKeyRingFromEnv(getApiEnv());
  }

  get isConfigured(): boolean {
    return this.ring !== undefined;
  }

  /** The key ring for sealing token bundles, or undefined when unconfigured. */
  get keyRing(): KeyRing | undefined {
    return this.ring;
  }

  /** Id stamped into new ciphertexts — stored beside them for rotation. */
  get activeKeyId(): string | null {
    return this.ring?.activeKeyId ?? null;
  }

  /** Encrypts a credential. Precondition: `isConfigured`. */
  seal(plaintext: string): string {
    if (!this.ring) {
      throw new Error('SocialCryptoService is not configured');
    }
    return encryptSecret(plaintext, this.ring);
  }

  /** Decrypts a value sealed by this service. Precondition: `isConfigured`. */
  open(sealed: string): string {
    if (!this.ring) {
      throw new Error('SocialCryptoService is not configured');
    }
    return decryptSecret(sealed, this.ring);
  }
}
