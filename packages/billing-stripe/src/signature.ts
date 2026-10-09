import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stripe webhook signature verification.
 *
 * Implemented directly rather than pulled from the SDK, because this is the
 * one piece of billing where a shortcut is a vulnerability, and it should be
 * readable and testable in this repository.
 *
 * Stripe signs `{timestamp}.{raw body}` with HMAC-SHA256 and sends the result
 * in `Stripe-Signature` as `t=<unix>,v1=<hex>[,v1=<hex>…]`. Four things have
 * to be right, and all four are tested:
 *
 *  1. The signed payload uses the **raw bytes**, not a re-serialized object.
 *  2. Comparison is **constant-time** — a fast-fail string compare leaks the
 *     expected signature one byte at a time.
 *  3. The **timestamp is checked** against a tolerance, or a captured request
 *     can be replayed forever.
 *  4. **Every** `v1` scheme is tried, because Stripe sends more than one
 *     during a secret rotation, and accepting only the first breaks rotation.
 */

export class WebhookSignatureError extends Error {
  readonly reason:
    | 'MISSING_HEADER'
    | 'MALFORMED_HEADER'
    | 'NO_TIMESTAMP'
    | 'NO_SIGNATURES'
    | 'TIMESTAMP_OUT_OF_TOLERANCE'
    | 'NO_MATCH';

  constructor(reason: WebhookSignatureError['reason'], message: string) {
    super(message);
    this.name = 'WebhookSignatureError';
    this.reason = reason;
  }
}

export interface ParsedSignatureHeader {
  timestamp: number;
  /** Every `v1` signature in the header, in order. */
  signatures: string[];
}

export function parseSignatureHeader(header: string): ParsedSignatureHeader {
  if (!header || header.trim().length === 0) {
    throw new WebhookSignatureError('MISSING_HEADER', 'No Stripe-Signature header was sent.');
  }
  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === 't') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) timestamp = parsed;
    } else if (key === 'v1') {
      signatures.push(value);
    }
  }

  if (timestamp === null) {
    throw new WebhookSignatureError('NO_TIMESTAMP', 'The signature header carries no timestamp.');
  }
  if (signatures.length === 0) {
    throw new WebhookSignatureError(
      'NO_SIGNATURES',
      'The signature header carries no v1 signature.',
    );
  }
  return { timestamp, signatures };
}

/** Constant-time hex comparison. Length mismatch is rejected without timing. */
export function secureCompare(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface VerifyOptions {
  /** Seconds a signature stays acceptable. Stripe's own default is 300. */
  toleranceSeconds?: number;
  now?: Date;
}

/**
 * Verifies the signature, or throws. Returns the raw body as a UTF-8 string
 * so the caller parses exactly what was signed.
 */
export function verifyStripeSignature(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string,
  options: VerifyOptions = {},
): string {
  const tolerance = options.toleranceSeconds ?? 300;
  const now = options.now ?? new Date();
  const { timestamp, signatures } = parseSignatureHeader(signatureHeader);

  // Replay window. Checked before the HMAC so a stale request is cheap to
  // reject, and checked in both directions — a far-future timestamp is as
  // suspect as an old one.
  const ageSeconds = Math.floor(now.getTime() / 1000) - timestamp;
  if (Math.abs(ageSeconds) > tolerance) {
    throw new WebhookSignatureError(
      'TIMESTAMP_OUT_OF_TOLERANCE',
      `The signature timestamp is ${ageSeconds}s away from now, outside the ${tolerance}s tolerance.`,
    );
  }

  const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
  const expected = createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');

  // Every candidate is compared, so a rotation that sends two signatures works.
  const matched = signatures.some((candidate) => secureCompare(candidate, expected));
  if (!matched) {
    throw new WebhookSignatureError('NO_MATCH', 'No signature in the header matched the payload.');
  }
  return rawBody.toString('utf8');
}
