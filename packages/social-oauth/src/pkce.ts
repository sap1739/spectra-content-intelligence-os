import { createHash, randomBytes } from 'node:crypto';

/**
 * PKCE (RFC 7636). The verifier is 32 random bytes, base64url — 43 characters
 * from the unreserved alphabet, 256 bits of entropy. Only the S256 challenge is
 * ever produced: `plain` would put the verifier itself in the browser URL.
 */

const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export function codeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function isValidCodeVerifier(verifier: string): boolean {
  return VERIFIER.test(verifier);
}
