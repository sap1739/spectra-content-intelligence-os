import { describe, expect, it } from 'vitest';

import { codeChallengeS256, generateCodeVerifier, isValidCodeVerifier } from './pkce';

describe('PKCE (RFC 7636)', () => {
  it('matches the RFC 7636 Appendix B test vector', () => {
    expect(codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('generates 43-character verifiers from the unreserved alphabet', () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toHaveLength(43);
    expect(isValidCodeVerifier(verifier)).toBe(true);
  });

  it('never repeats a verifier', () => {
    const verifiers = new Set(Array.from({ length: 200 }, () => generateCodeVerifier()));
    expect(verifiers.size).toBe(200);
  });

  it('derives a challenge that does not reveal the verifier', () => {
    const verifier = generateCodeVerifier();
    const challenge = codeChallengeS256(verifier);
    expect(challenge).not.toBe(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('rejects verifiers outside the RFC length and alphabet', () => {
    expect(isValidCodeVerifier('too-short')).toBe(false);
    expect(isValidCodeVerifier('a'.repeat(129))).toBe(false);
    expect(isValidCodeVerifier(`${'a'.repeat(42)}!`)).toBe(false);
  });
});
