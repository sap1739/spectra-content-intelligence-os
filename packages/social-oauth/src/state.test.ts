import { describe, expect, it } from 'vitest';

import { generateState, hashState, isWellFormedState } from './state';

describe('OAuth state', () => {
  it('is 256 bits of base64url', () => {
    const state = generateState();
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isWellFormedState(state)).toBe(true);
  });

  it('is unique per flow', () => {
    const states = new Set(Array.from({ length: 200 }, () => generateState()));
    expect(states.size).toBe(200);
  });

  it('is stored only as a deterministic SHA-256 hash', () => {
    const state = generateState();
    const hash = hashState(state);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashState(state));
    expect(hash).not.toContain(state);
    expect(hashState(generateState())).not.toBe(hash);
  });

  it('rejects malformed state before any lookup', () => {
    expect(isWellFormedState('')).toBe(false);
    expect(isWellFormedState('short')).toBe(false);
    expect(isWellFormedState(`${'a'.repeat(42)}=`)).toBe(false);
    expect(isWellFormedState(`${'a'.repeat(43)}' OR 1=1 --`)).toBe(false);
  });
});
