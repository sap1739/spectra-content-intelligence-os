import { describe, expect, it } from 'vitest';

import { hashPassword, needsRehash, verifyPassword } from './passwords';

// Reduced-cost params keep the suite fast; production defaults stay strong.
const FAST = { N: 1024, r: 8, p: 1 };

describe('password hashing (scrypt)', () => {
  it('hashes and verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple', FAST);
    expect(hash.startsWith('scrypt$N=1024,r=8,p=1$')).toBe(true);
    expect(hash).not.toContain('correct horse');
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple', FAST);
    await expect(verifyPassword('wrong password entirely', hash)).resolves.toBe(false);
  });

  it('salts uniquely — same password, different hashes', async () => {
    const a = await hashPassword('same-password-123', FAST);
    const b = await hashPassword('same-password-123', FAST);
    expect(a).not.toBe(b);
    await expect(verifyPassword('same-password-123', a)).resolves.toBe(true);
    await expect(verifyPassword('same-password-123', b)).resolves.toBe(true);
  });

  it('fails closed on malformed stored hashes', async () => {
    await expect(verifyPassword('anything', 'not-a-hash')).resolves.toBe(false);
    await expect(verifyPassword('anything', 'scrypt$bad$x$y')).resolves.toBe(false);
    await expect(verifyPassword('anything', '')).resolves.toBe(false);
  });

  it('flags weaker-than-current hashes for rehash', async () => {
    const weak = await hashPassword('some-password-abc', FAST);
    expect(needsRehash(weak)).toBe(true);
    expect(needsRehash('garbage')).toBe(true);
  });

  it('rejects empty passwords at hash time', async () => {
    await expect(hashPassword('', FAST)).rejects.toThrow();
  });
});
