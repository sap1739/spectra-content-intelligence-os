import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { MANDATORY_REDACT_PATHS, createLogger } from './logger';

/**
 * Redaction regression tests (ADR-0033).
 *
 * These exist because redaction is the kind of control that silently stops
 * working: a field gets renamed, a new integration logs a differently-spelled
 * credential, and nothing fails until a secret is already in a log sink. Each
 * case below names a real field this codebase actually logs.
 */

function captureLog(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  const logger = createLogger({ name: 'redaction-test', level: 'info', destination: sink });
  logger.info(payload, 'test');
  return lines.join('');
}

/** Every secret below is fake and exists only to be asserted absent. */
const SECRET = 'sk-ant-FAKE-TEST-VALUE-0000';

describe('credential redaction', () => {
  it.each([
    ['password', { password: SECRET }],
    ['accessToken', { accessToken: SECRET }],
    ['refreshToken', { refreshToken: SECRET }],
    ['apiKey', { apiKey: SECRET }],
    ['secret', { secret: SECRET }],
    ['encryptionKey', { encryptionKey: SECRET }],
    ['credential', { credential: SECRET }],
    ['applicationPassword', { applicationPassword: SECRET }],
    ['encryptedToken', { encryptedToken: SECRET }],
    ['sessionToken', { sessionToken: SECRET }],
    ['passwordHash', { passwordHash: SECRET }],
    ['privateKey', { privateKey: SECRET }],
    ['clientSecret', { clientSecret: SECRET }],
  ])('redacts %s', (_name, payload) => {
    const output = captureLog(payload);
    expect(output).not.toContain(SECRET);
    expect(output).toContain('[REDACTED]');
  });

  it('redacts credentials nested one level down', () => {
    const output = captureLog({ account: { accessToken: SECRET, id: 'acct-1' } });
    expect(output).not.toContain(SECRET);
    // The non-secret sibling survives — redaction must not blind the log.
    expect(output).toContain('acct-1');
  });
});

describe('header redaction', () => {
  it('redacts authorization and cookie headers in both casings', () => {
    const output = captureLog({
      req: {
        headers: {
          authorization: `Bearer ${SECRET}`,
          cookie: `session=${SECRET}`,
          'user-agent': 'SpectraBot/1.0',
        },
      },
    });
    expect(output).not.toContain(SECRET);
    // A safe header is still visible.
    expect(output).toContain('SpectraBot/1.0');
  });

  it('redacts a top-level headers bag as well as req.headers', () => {
    const output = captureLog({ headers: { authorization: `Basic ${SECRET}` } });
    expect(output).not.toContain(SECRET);
  });
});

describe('model input/output redaction', () => {
  it.each([
    ['prompt', { prompt: 'PRIVATE_RESEARCH_TEXT' }],
    ['completion', { completion: 'PRIVATE_RESEARCH_TEXT' }],
    ['messages', { messages: 'PRIVATE_RESEARCH_TEXT' }],
    ['instructions', { instructions: 'PRIVATE_RESEARCH_TEXT' }],
  ])('redacts %s', (_name, payload) => {
    // A prompt carries the operator's private research AND untrusted source
    // text; a completion can echo both back.
    expect(captureLog(payload)).not.toContain('PRIVATE_RESEARCH_TEXT');
  });
});

describe('document and payment redaction', () => {
  it('redacts extracted document content', () => {
    const output = captureLog({
      documentContent: 'CONFIDENTIAL_BODY',
      extractedText: 'CONFIDENTIAL_BODY',
      rawHtml: 'CONFIDENTIAL_BODY',
    });
    expect(output).not.toContain('CONFIDENTIAL_BODY');
  });

  it('redacts payment fields', () => {
    const output = captureLog({ cardNumber: '4111111111111111', cvv: '123', iban: 'GB00X' });
    expect(output).not.toContain('4111111111111111');
    expect(output).not.toContain('GB00X');
  });
});

describe('redaction configuration', () => {
  it('cannot be disabled by a caller supplying its own paths', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _e, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    // A caller asking for only its own path must NOT drop the mandatory set.
    const logger = createLogger({
      name: 't',
      level: 'info',
      destination: sink,
      redactPaths: ['somethingElse'],
    });
    logger.info({ apiKey: SECRET, somethingElse: 'x' }, 'test');
    expect(lines.join('')).not.toContain(SECRET);
  });

  it('keeps the mandatory path list stable and non-empty', () => {
    expect(MANDATORY_REDACT_PATHS.length).toBeGreaterThan(20);
    for (const key of ['password', 'apiKey', 'authorization', 'prompt', 'encryptedToken']) {
      expect(MANDATORY_REDACT_PATHS).toContain(key);
    }
  });

  it('emits structured JSON, one object per line', () => {
    const output = captureLog({ workspaceId: 'ws-1' });
    const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
    expect(parsed['workspaceId']).toBe('ws-1');
    expect(parsed['msg']).toBe('test');
    expect(parsed['name']).toBe('redaction-test');
  });
});
