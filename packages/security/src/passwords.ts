import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

/** promisify() loses the options overload — wrap explicitly. */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/**
 * Password hashing with Node's built-in scrypt (no native dependency).
 *
 * Format: `scrypt$N=<cost>,r=<blockSize>,p=<parallelism>$<salt>$<hash>`
 * (base64url salt/hash). Parameters are embedded so they can be raised later
 * while old hashes keep verifying; `needsRehash` detects outdated hashes.
 */

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** Current defaults — ~64 MiB memory per hash, OWASP-acceptable. */
export const CURRENT_SCRYPT_PARAMS: ScryptParams = { N: 65536, r: 8, p: 1 };

const SALT_BYTES = 16;
const KEY_LENGTH = 32;

function maxmemFor(params: ScryptParams): number {
  // Node requires maxmem > 128 * N * r; leave 2x headroom.
  return 256 * params.N * params.r;
}

export async function hashPassword(
  password: string,
  params: ScryptParams = CURRENT_SCRYPT_PARAMS,
): Promise<string> {
  if (password.length === 0) {
    throw new Error('Password must not be empty');
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = (await scrypt(password, salt, KEY_LENGTH, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: maxmemFor(params),
  })) as Buffer;
  return [
    'scrypt',
    `N=${params.N},r=${params.r},p=${params.p}`,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

function parseHash(stored: string): { params: ScryptParams; salt: Buffer; hash: Buffer } | null {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return null;
  const paramMatch = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(parts[1] as string);
  if (!paramMatch) return null;
  return {
    params: {
      N: Number(paramMatch[1]),
      r: Number(paramMatch[2]),
      p: Number(paramMatch[3]),
    },
    salt: Buffer.from(parts[2] as string, 'base64url'),
    hash: Buffer.from(parts[3] as string, 'base64url'),
  };
}

/** Constant-time verification. Malformed stored hashes verify as false. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed || parsed.salt.length === 0 || parsed.hash.length === 0) return false;
  try {
    const derived = (await scrypt(password, parsed.salt, parsed.hash.length, {
      ...parsed.params,
      maxmem: maxmemFor(parsed.params),
    })) as Buffer;
    return timingSafeEqual(derived, parsed.hash);
  } catch {
    return false;
  }
}

/** True when the stored hash uses weaker-than-current parameters. */
export function needsRehash(stored: string): boolean {
  const parsed = parseHash(stored);
  if (!parsed) return true;
  const { N, r, p } = CURRENT_SCRYPT_PARAMS;
  return parsed.params.N < N || parsed.params.r < r || parsed.params.p < p;
}
