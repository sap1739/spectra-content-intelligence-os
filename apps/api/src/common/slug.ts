import { randomBytes } from 'node:crypto';

/** Lowercase kebab-case slug from arbitrary user text. */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return slug || 'item';
}

/** Short random suffix for slug uniqueness (not security-sensitive). */
export function uniqueSuffix(): string {
  return randomBytes(3).toString('hex');
}
