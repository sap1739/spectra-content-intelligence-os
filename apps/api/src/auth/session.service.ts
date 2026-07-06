import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { RedisService } from '../redis/redis.service';

export const SESSION_COOKIE = 'spectra_session';
/** Fixed session lifetime; revocation is instant via Redis deletion. */
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

interface SessionRecord {
  userId: string;
  createdAt: string;
}

/**
 * Opaque, server-side sessions in Redis (ADR-0014). The cookie carries only a
 * random 256-bit id; the principal is rebuilt from the database per request,
 * so membership/permission changes take effect immediately.
 */
@Injectable()
export class SessionService {
  constructor(private readonly redis: RedisService) {}

  private key(sessionId: string): string {
    return `spectra:session:${sessionId}`;
  }

  async create(userId: string): Promise<string> {
    const sessionId = randomBytes(32).toString('base64url');
    const record: SessionRecord = { userId, createdAt: new Date().toISOString() };
    await this.redis.client.set(
      this.key(sessionId),
      JSON.stringify(record),
      'EX',
      SESSION_TTL_SECONDS,
    );
    return sessionId;
  }

  async resolveUserId(sessionId: string): Promise<string | null> {
    if (!sessionId || sessionId.length > 128) return null;
    const raw = await this.redis.client.get(this.key(sessionId));
    if (!raw) return null;
    try {
      const record = JSON.parse(raw) as SessionRecord;
      return record.userId ?? null;
    } catch {
      return null;
    }
  }

  async destroy(sessionId: string): Promise<void> {
    await this.redis.client.del(this.key(sessionId));
  }
}
