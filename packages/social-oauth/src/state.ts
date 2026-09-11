import { createHash, randomBytes } from 'node:crypto';

/**
 * The OAuth `state` parameter (RFC 6749 section 10.12).
 *
 * 32 random bytes, base64url. Only its SHA-256 hash is stored — the same
 * treatment as a session id — so a database read cannot be replayed into a
 * callback. The raw value exists in exactly two places: the authorization URL
 * and the callback query string.
 */

const STATE = /^[A-Za-z0-9_-]{43}$/;

export function generateState(): string {
  return randomBytes(32).toString('base64url');
}

export function hashState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

/** Cheap shape check before any database work. */
export function isWellFormedState(state: string): boolean {
  return STATE.test(state);
}
