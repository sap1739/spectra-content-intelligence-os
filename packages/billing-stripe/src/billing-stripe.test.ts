import { createHmac } from 'node:crypto';

import { BillingProviderError } from '@spectra/billing-core';
import { describe, expect, it } from 'vitest';

import {
  WebhookSignatureError,
  parseSignatureHeader,
  secureCompare,
  verifyStripeSignature,
} from './signature';
import {
  StripeBillingProvider,
  formEncode,
  mapSubscriptionStatus,
  modeFromKey,
  parseSubscription,
} from './stripe-provider';

const SECRET = 'whsec_test_secret';
const NOW = new Date('2026-10-08T12:00:00.000Z');

function sign(body: string, secret = SECRET, at: Date = NOW, scheme = 'v1'): string {
  const timestamp = Math.floor(at.getTime() / 1000);
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`, 'utf8')
    .digest('hex');
  return `t=${timestamp},${scheme}=${signature}`;
}

describe('webhook signature verification', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated' });

  it('accepts a correctly signed payload', () => {
    expect(verifyStripeSignature(Buffer.from(body), sign(body), SECRET, { now: NOW })).toBe(body);
  });

  it('rejects a payload signed with a different secret', () => {
    expect(() =>
      verifyStripeSignature(Buffer.from(body), sign(body, 'whsec_other'), SECRET, { now: NOW }),
    ).toThrow(WebhookSignatureError);
  });

  it('rejects a body that changed after signing, byte for byte', () => {
    const header = sign(body);
    // One character different — the HMAC must not match.
    const tampered = body.replace('evt_1', 'evt_2');

    expect(() =>
      verifyStripeSignature(Buffer.from(tampered), header, SECRET, { now: NOW }),
    ).toThrow(/No signature in the header matched/);
  });

  it('rejects a re-serialized body, which is why raw bytes are required', () => {
    // A caller that parsed then re-stringified the JSON would reorder or
    // re-space it; the signature is over the original bytes.
    const reserialized = JSON.stringify(JSON.parse(body), null, 2);

    expect(() =>
      verifyStripeSignature(Buffer.from(reserialized), sign(body), SECRET, { now: NOW }),
    ).toThrow(WebhookSignatureError);
  });

  it('rejects a replayed request outside the tolerance window', () => {
    const old = new Date(NOW.getTime() - 10 * 60_000);

    const error = (() => {
      try {
        verifyStripeSignature(Buffer.from(body), sign(body, SECRET, old), SECRET, { now: NOW });
        return null;
      } catch (caught) {
        return caught as WebhookSignatureError;
      }
    })();

    expect(error?.reason).toBe('TIMESTAMP_OUT_OF_TOLERANCE');
  });

  it('rejects a far-future timestamp as firmly as an old one', () => {
    const future = new Date(NOW.getTime() + 10 * 60_000);

    expect(() =>
      verifyStripeSignature(Buffer.from(body), sign(body, SECRET, future), SECRET, { now: NOW }),
    ).toThrow(/outside the 300s tolerance/);
  });

  it('accepts a signature still inside the tolerance', () => {
    const recent = new Date(NOW.getTime() - 4 * 60_000);

    expect(
      verifyStripeSignature(Buffer.from(body), sign(body, SECRET, recent), SECRET, { now: NOW }),
    ).toBe(body);
  });

  it('accepts a rotation header carrying two v1 signatures', () => {
    // During a secret rotation Stripe signs with both; accepting only the
    // first would break the rotation.
    const timestamp = Math.floor(NOW.getTime() / 1000);
    const good = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
    const header = `t=${timestamp},v1=deadbeef,v1=${good}`;

    expect(verifyStripeSignature(Buffer.from(body), header, SECRET, { now: NOW })).toBe(body);
  });

  it('refuses a header with no timestamp or no v1 signature', () => {
    expect(() => parseSignatureHeader('v1=abc')).toThrow(/no timestamp/);
    expect(() => parseSignatureHeader('t=123')).toThrow(/no v1 signature/);
    expect(() => parseSignatureHeader('')).toThrow(/No Stripe-Signature header/);
  });

  it('ignores schemes it does not understand, like v0', () => {
    const timestamp = Math.floor(NOW.getTime() / 1000);
    const header = `t=${timestamp},v0=abc`;

    expect(() => parseSignatureHeader(header)).toThrow(/no v1 signature/);
  });

  it('compares in constant time, and rejects a length mismatch', () => {
    expect(secureCompare('abc', 'abc')).toBe(true);
    expect(secureCompare('abc', 'abd')).toBe(false);
    expect(secureCompare('abc', 'abcd')).toBe(false);
  });
});

describe('mode separation', () => {
  it('derives the mode from the key, so test and live cannot be confused', () => {
    expect(modeFromKey('sk_test_123')).toBe('TEST');
    expect(modeFromKey('sk_live_123')).toBe('LIVE');
    expect(modeFromKey('rk_live_123')).toBe('LIVE');
    // A key of unknown shape yields no mode, and the provider refuses to run.
    expect(modeFromKey('pk_test_123')).toBeNull();
    expect(modeFromKey(null)).toBeNull();
  });

  it('refuses to operate on a key whose mode cannot be determined', () => {
    const provider = new StripeBillingProvider({
      secretKey: 'something_odd',
      webhookSecret: SECRET,
    });

    const capability = provider.capabilities();
    expect(capability.available).toBe(false);
    expect(capability.reason).toContain('neither a test');
    expect(capability.mode).toBeNull();
  });
});

describe('capability reporting', () => {
  it('says plainly what is missing when nothing is configured', () => {
    const capability = new StripeBillingProvider({
      secretKey: null,
      webhookSecret: null,
    }).capabilities();

    expect(capability.available).toBe(false);
    expect(capability.requiredEnv).toEqual(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']);
    // Crucially: plans still apply. Unconfigured billing is not unlimited use.
    expect(capability.reason).toContain('free plan');
    expect(capability.webhooksVerifiable).toBe(false);
  });

  it('warns when a key is set but no webhook secret is, because status will never update', () => {
    const capability = new StripeBillingProvider({
      secretKey: 'sk_test_123',
      webhookSecret: null,
    }).capabilities();

    expect(capability.available).toBe(true);
    expect(capability.mode).toBe('TEST');
    expect(capability.webhooksVerifiable).toBe(false);
    expect(capability.reason).toContain('status will never update');
  });

  it('refuses to verify a webhook at all when no secret is configured', () => {
    const provider = new StripeBillingProvider({ secretKey: 'sk_test_1', webhookSecret: null });

    expect(() => provider.verifyWebhook(Buffer.from('{}'), 't=1,v1=x')).toThrow(
      /refused rather than trusted/,
    );
  });
});

describe('subscription mapping', () => {
  it('maps every Stripe status Spectra knows', () => {
    expect(mapSubscriptionStatus('active')).toBe('ACTIVE');
    expect(mapSubscriptionStatus('past_due')).toBe('PAST_DUE');
    expect(mapSubscriptionStatus('incomplete_expired')).toBe('INCOMPLETE_EXPIRED');
  });

  it('fails closed on a status it does not recognise, rather than assuming active', () => {
    expect(() => mapSubscriptionStatus('some_new_state')).toThrow(BillingProviderError);
    expect(() => mapSubscriptionStatus(undefined)).toThrow(/does not recognise/);
  });

  it('parses the fields Spectra mirrors, and nothing about payment instruments', () => {
    const parsed = parseSubscription({
      id: 'sub_1',
      customer: 'cus_1',
      status: 'trialing',
      current_period_start: 1_760_000_000,
      current_period_end: 1_762_000_000,
      cancel_at_period_end: true,
      trial_end: 1_761_000_000,
      items: { data: [{ price: { id: 'price_1' } }] },
      // Stripe sends far more than this; none of it is carried over.
      default_payment_method: 'pm_secret',
      latest_invoice: 'in_1',
    });

    expect(parsed).toMatchObject({
      id: 'sub_1',
      customerId: 'cus_1',
      status: 'TRIALING',
      priceId: 'price_1',
      cancelAtPeriodEnd: true,
    });
    expect(parsed.currentPeriodEnd?.toISOString()).toBe('2025-11-01T12:26:40.000Z');
    expect(JSON.stringify(parsed)).not.toContain('pm_secret');
  });

  it('reads an expanded customer object as well as a bare id', () => {
    expect(
      parseSubscription({ id: 's', customer: { id: 'cus_9' }, status: 'active' }).customerId,
    ).toBe('cus_9');
  });
});

describe('verifyWebhook', () => {
  const provider = new StripeBillingProvider({ secretKey: 'sk_test_1', webhookSecret: SECRET });

  it('returns the parsed event with its mode taken from livemode', () => {
    const body = JSON.stringify({
      id: 'evt_9',
      type: 'invoice.payment_failed',
      livemode: false,
      created: Math.floor(NOW.getTime() / 1000),
      data: { object: { id: 'in_1' } },
    });

    const event = provider.verifyWebhook(Buffer.from(body), sign(body), NOW);

    expect(event).toMatchObject({ id: 'evt_9', type: 'invoice.payment_failed', mode: 'TEST' });
    expect(event.object).toEqual({ id: 'in_1' });
  });

  it('marks a livemode event as LIVE, so it cannot be applied in test', () => {
    const body = JSON.stringify({
      id: 'evt_live',
      type: 'customer.subscription.updated',
      livemode: true,
      created: Math.floor(NOW.getTime() / 1000),
      data: { object: {} },
    });

    expect(provider.verifyWebhook(Buffer.from(body), sign(body), NOW).mode).toBe('LIVE');
  });

  it('rejects a verified-but-malformed event rather than half-processing it', () => {
    const body = JSON.stringify({ id: 'evt_1' });

    expect(() => provider.verifyWebhook(Buffer.from(body), sign(body), NOW)).toThrow(
      /missing an id, a type or a data object/,
    );
  });

  it('rejects a body that is not JSON, after the signature passes', () => {
    const body = 'not json';

    expect(() => provider.verifyWebhook(Buffer.from(body), sign(body), NOW)).toThrow(
      /not valid JSON/,
    );
  });
});

describe('formEncode', () => {
  it('encodes nested objects and arrays the way Stripe expects', () => {
    const encoded = formEncode({
      mode: 'subscription',
      metadata: { organizationId: 'org-1' },
      line_items: [{ price: 'price_1', quantity: 1 }],
    });

    expect(encoded).toContain('mode=subscription');
    expect(encoded).toContain('metadata%5BorganizationId%5D=org-1');
    expect(encoded).toContain('line_items%5B0%5D%5Bprice%5D=price_1');
  });

  it('omits null and undefined rather than sending the string "null"', () => {
    expect(formEncode({ a: 1, b: null, c: undefined })).toBe('a=1');
  });
});
