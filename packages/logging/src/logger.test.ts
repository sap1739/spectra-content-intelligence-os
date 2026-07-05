import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger, withCorrelation } from './logger';

function captureStream(lines: string[]): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
}

describe('createLogger', () => {
  it('emits structured JSON with service name and ISO timestamp', () => {
    const lines: string[] = [];
    const logger = createLogger({ name: 'test-service', destination: captureStream(lines) });

    logger.info({ hello: 'world' }, 'greeting');
    logger.flush();

    const entry = JSON.parse(lines[0] ?? '{}');
    expect(entry.service).toBe('test-service');
    expect(entry.msg).toBe('greeting');
    expect(entry.hello).toBe('world');
    expect(entry.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('redacts sensitive fields at any depth', () => {
    const lines: string[] = [];
    const logger = createLogger({ name: 'test-service', destination: captureStream(lines) });

    logger.info(
      {
        password: 'super-secret',
        oauth: { accessToken: 'tok_123', refreshToken: 'ref_456' },
        payment: { cardNumber: '4111111111111111' },
      },
      'sensitive',
    );
    logger.flush();

    const raw = lines[0] ?? '';
    expect(raw).not.toContain('super-secret');
    expect(raw).not.toContain('tok_123');
    expect(raw).not.toContain('ref_456');
    expect(raw).not.toContain('4111111111111111');
    expect(raw).toContain('[REDACTED]');
  });

  it('attaches correlation ids via child loggers', () => {
    const lines: string[] = [];
    const logger = createLogger({ name: 'test-service', destination: captureStream(lines) });

    withCorrelation(logger, 'corr-abc').info('with correlation');
    logger.flush();

    const entry = JSON.parse(lines[0] ?? '{}');
    expect(entry.correlationId).toBe('corr-abc');
  });
});
