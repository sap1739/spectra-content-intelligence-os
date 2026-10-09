# Billing Live Verification Checklist

**Status: NOT RUN.** Every billing test in this repository runs against a local stand-in that
enforces Stripe's documented request shapes. No request has been sent to Stripe, and no webhook has
been received from Stripe. This checklist is what would establish that.

## Before starting

Use a **test-mode** Stripe account. `sk_test_…` keys cannot move real money, and the mode guard
(ADR-0044) will refuse to apply a live event to a test deployment anyway.

1. Create a product and a recurring price per plan in Stripe.
2. Insert a `ProductPrice` row per plan, with `mode = TEST` and the `price_…` id.
3. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `BILLING_RETURN_ORIGIN`.
4. Forward webhooks: `stripe listen --forward-to localhost:4000/v1/billing/webhook/stripe`.

## Checklist

| #   | Check                                                               | Expected                                                                                    |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | `GET /billing/capabilities`                                         | `available: true`, `mode: TEST`, `webhooksVerifiable: true`                                 |
| 2   | `POST /billing/checkout` and complete it with `4242 4242 4242 4242` | Redirects to Stripe; subscription becomes `ACTIVE` **only after** the webhook               |
| 3   | Inspect `billing_webhook_events`                                    | `checkout.session.completed` and `customer.subscription.created` both `PROCESSED`           |
| 4   | Replay an event: `stripe events resend <id>`                        | Second delivery returns `duplicate: true`; **no second credit grant**                       |
| 5   | Tamper with a forwarded body                                        | `400`, nothing written                                                                      |
| 6   | Rotate the webhook secret in Stripe, keep both active               | Deliveries keep verifying (the multi-`v1` path)                                             |
| 7   | Pay with `4000 0000 0000 0341` (fails after attach)                 | `invoice.payment_failed` → banner shows Stripe's own message; plan still works (`PAST_DUE`) |
| 8   | Update to a working card in the portal                              | `invoice.payment_succeeded` → banner clears                                                 |
| 9   | Cancel in the portal                                                | Status `CANCELED`; entitlements drop to the free plan                                       |
| 10  | Let a period roll over (`stripe clock` or wait)                     | Exactly one new `MONTHLY_ALLOWANCE` grant; the previous one has lapsed                      |
| 11  | Check the Stripe dashboard against Spectra                          | Spectra shows no amount anywhere — only Stripe does                                         |
| 12  | Grep the API logs for `sk_test_`, `whsec_`                          | No matches                                                                                  |

## Open questions the documentation does not settle

- **Event ordering.** Stripe does not guarantee it. Spectra re-reads the subscription from the API
  on every subscription event rather than trusting the body, which should make ordering
  irrelevant — worth confirming against a real out-of-order delivery.
- **`current_period_start` on plan change.** Whether an upgrade mid-period starts a new period
  decides whether a second monthly allowance is granted. The `grantKey` includes the period start,
  so a new period means new credits. Confirm that is the intended commercial behaviour.
- **Portal-initiated plan changes** arrive as `customer.subscription.updated` with a new price.
  Confirm the price → plan mapping resolves for every configured price, and that a price removed
  from Stripe but still referenced by a live subscription fails loudly rather than silently
  falling back.
- **Trials.** `trialing` is treated as entitled. Confirm what Stripe sends when a trial ends
  without a payment method, and that the resulting state falls back rather than lingering.
