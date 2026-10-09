'use client';

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Skeleton,
} from '@spectra/ui';
import { AlertTriangle, CreditCard, ExternalLink, Info, Lock } from 'lucide-react';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { UsageAndBudgets } from '@/components/usage-and-budgets';
import { usePermissions, useWorkspace } from '@/lib/auth';
import {
  SUBSCRIPTION_VARIANT,
  formatLimit,
  formatMoney,
  useBillingCapabilities,
  useCheckout,
  useCredits,
  useEntitlements,
  useGrantCredits,
  usePlans,
  usePortal,
  useSubscription,
} from '@/lib/billing';
import type { EntitlementKey } from '@spectra/contracts';

/**
 * Billing (Phase 8A, ADR-0044).
 *
 * The page's first duty is the distinction that the rest of the product
 * depends on: the usage figures elsewhere in Spectra are ESTIMATES, and the
 * only authority on what a customer is charged is the provider's invoice.
 * That sentence is shown, not implied.
 */
export default function BillingPage() {
  const { activeWorkspace } = useWorkspace();
  const organizationId = activeWorkspace.organizationId;
  const { can } = usePermissions();
  const canManage = can('org:billing:manage');

  const capabilities = useBillingCapabilities(organizationId);
  const plans = usePlans(organizationId);
  const subscription = useSubscription(organizationId);
  const entitlements = useEntitlements(organizationId);
  const credits = useCredits(organizationId);
  const checkout = useCheckout(organizationId);
  const portal = usePortal(organizationId);
  const grant = useGrantCredits(organizationId);

  const [grantAmount, setGrantAmount] = React.useState('');
  const [grantReason, setGrantReason] = React.useState('');

  const state = subscription.data;
  const provider = capabilities.data?.provider;

  async function startCheckout(planKey: string) {
    const session = await checkout.mutateAsync({
      planKey,
      interval: 'MONTH',
      successPath: '/billing?checkout=success',
      cancelPath: '/billing?checkout=cancelled',
    });
    // The provider owns the card form; Spectra only ever sends the browser.
    window.location.href = session.url;
  }

  async function openPortal() {
    const session = await portal.mutateAsync();
    window.location.href = session.url;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Billing"
        description="Your plan, what it includes, and the credits behind it."
      />

      {/* The distinction the whole phase exists to protect. */}
      <Card>
        <CardContent className="flex items-start gap-3 pt-6 text-sm">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="space-y-2">
            <p className="font-medium">Usage estimates are not invoices</p>
            <p className="text-muted-foreground" data-testid="estimate-disclaimer">
              {capabilities.data?.estimatesAreNotInvoices ??
                'Usage figures in Spectra are estimates of provider spend. They are not invoices and will not match what you are charged.'}
            </p>
            {capabilities.isLoading ? (
              <Skeleton className="h-4 w-80" />
            ) : provider?.available ? (
              <p className="text-muted-foreground" data-testid="billing-configured">
                Billing is configured in <strong>{provider.mode}</strong> mode.
                {provider.webhooksVerifiable
                  ? ''
                  : ' No webhook secret is set, so subscription changes will not be received.'}
              </p>
            ) : (
              <p className="text-amber-700 dark:text-amber-400" data-testid="billing-unconfigured">
                {provider?.reason}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {state?.paymentFailed ? (
        <Card className="border-destructive">
          <CardContent className="flex items-start gap-3 pt-6 text-sm" data-testid="payment-failed">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="space-y-2">
              <p className="font-medium text-destructive">The last payment failed</p>
              <p className="text-muted-foreground">
                {state.subscription?.lastPaymentFailureMessage ??
                  'The provider reported a failed payment.'}{' '}
                Your plan keeps working while the provider retries. Update the payment method in the
                customer portal.
              </p>
              {canManage ? (
                <Button size="sm" variant="outline" onClick={() => void openPortal()}>
                  <ExternalLink aria-hidden className="size-4" /> Open customer portal
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Current subscription</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {subscription.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : state?.subscription ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <Badge variant={SUBSCRIPTION_VARIANT[state.subscription.status]}>
                  {state.subscription.status}
                </Badge>
                <span className="font-medium">{state.subscription.planName}</span>
                {state.subscription.mode === 'TEST' ? (
                  <Badge variant="muted">TEST MODE</Badge>
                ) : null}
              </div>
              {state.subscription.currentPeriodEnd ? (
                <p className="text-muted-foreground">
                  {state.subscription.cancelAtPeriodEnd ? 'Ends' : 'Renews'}{' '}
                  {new Date(state.subscription.currentPeriodEnd).toLocaleDateString()}.
                </p>
              ) : null}
              {state.downgradedToFallback ? (
                <p className="text-amber-700 dark:text-amber-400" data-testid="downgraded">
                  This subscription is {state.subscription.status.toLowerCase()}, so the{' '}
                  <strong>{state.effectivePlanKey}</strong> plan&rsquo;s limits currently apply.
                </p>
              ) : null}
              {canManage ? (
                <Button size="sm" variant="outline" onClick={() => void openPortal()}>
                  <ExternalLink aria-hidden className="size-4" /> Manage in customer portal
                </Button>
              ) : null}
            </>
          ) : (
            <p className="text-muted-foreground" data-testid="no-subscription">
              No subscription. The <strong>{state?.effectivePlanKey ?? 'free'}</strong> plan&rsquo;s
              limits apply — not unlimited use.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Plans</CardTitle>
        </CardHeader>
        <CardContent>
          {plans.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2" data-testid="plans">
              {plans.data?.plans.map((plan) => {
                const price = plan.prices[0];
                const current = state?.effectivePlanKey === plan.key;
                return (
                  <li key={plan.id} className="rounded-md border border-border p-4 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{plan.name}</span>
                      {current ? <Badge variant="success">Current</Badge> : null}
                    </div>
                    <p className="mt-1 text-muted-foreground">{plan.description}</p>
                    <p className="mt-2 font-medium">
                      {price
                        ? `${formatMoney(price.unitAmount, price.currency)} / ${price.interval.toLowerCase()}`
                        : 'Price not configured'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {plan.monthlyCredits.toLocaleString()} credits each period
                    </p>
                    {canManage && plan.purchasable && !current ? (
                      <Button
                        size="sm"
                        className="mt-3"
                        disabled={checkout.isPending}
                        onClick={() => void startCheckout(plan.key)}
                      >
                        <CreditCard aria-hidden className="size-4" /> Choose {plan.name}
                      </Button>
                    ) : !plan.purchasable && !current ? (
                      <p className="mt-3 text-xs text-muted-foreground">
                        {plan.selfServe
                          ? 'No price is configured for this plan yet.'
                          : 'Contact sales to move to this plan.'}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {checkout.isError ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {checkout.error.message}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Plan limits</CardTitle>
        </CardHeader>
        <CardContent>
          {entitlements.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <ul className="space-y-2 text-sm" data-testid="entitlements">
              {entitlements.data?.decisions.map((decision) => {
                const definition =
                  capabilities.data?.entitlementDefinitions[decision.key as EntitlementKey];
                const atLimit = !decision.allowed;
                return (
                  <li
                    key={decision.key}
                    className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2"
                  >
                    <span>
                      <span className="font-medium">{definition?.label ?? decision.key}</span>{' '}
                      <span className="text-muted-foreground">
                        {decision.key === 'ANALYTICS_SYNC_MIN_INTERVAL_MINUTES'
                          ? formatLimit(decision.key as EntitlementKey, decision.limit)
                          : `${decision.used.toLocaleString()} of ${formatLimit(decision.key as EntitlementKey, decision.limit)}`}
                      </span>
                    </span>
                    {atLimit ? <Badge variant="destructive">At limit</Badge> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Credits</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {credits.isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <>
              <div className="flex flex-wrap gap-6" data-testid="credit-balance">
                <span>
                  <span className="block text-2xl font-semibold tabular-nums">
                    {credits.data?.balance.available.toLocaleString()}
                  </span>
                  <span className="text-xs text-muted-foreground">Available</span>
                </span>
                <span>
                  <span className="block text-2xl font-semibold tabular-nums">
                    {credits.data?.balance.consumedThisPeriod.toLocaleString()}
                  </span>
                  <span className="text-xs text-muted-foreground">Used this period</span>
                </span>
                <span>
                  <span className="block text-2xl font-semibold tabular-nums">
                    {credits.data?.balance.expiringAtPeriodEnd.toLocaleString()}
                  </span>
                  <span className="text-xs text-muted-foreground">Expiring at period end</span>
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Credits are spent soonest-expiring first, so a monthly allowance is used before
                anything you bought.
              </p>
            </>
          )}

          {canManage ? (
            <form
              className="flex flex-wrap items-end gap-3 border-t border-border pt-3"
              onSubmit={(event) => {
                event.preventDefault();
                const amount = Number(grantAmount);
                if (!Number.isFinite(amount) || amount <= 0 || !grantReason.trim()) return;
                grant.mutate({ amount, reason: grantReason.trim(), expiresAt: null });
                setGrantAmount('');
                setGrantReason('');
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="grant-amount">Grant credits</Label>
                <Input
                  id="grant-amount"
                  type="number"
                  min={1}
                  value={grantAmount}
                  onChange={(event) => setGrantAmount(event.target.value)}
                  className="w-32"
                />
              </div>
              <div className="min-w-48 flex-1 space-y-1.5">
                <Label htmlFor="grant-reason">Reason</Label>
                <Input
                  id="grant-reason"
                  value={grantReason}
                  onChange={(event) => setGrantReason(event.target.value)}
                  placeholder="Goodwill after an outage"
                />
              </div>
              <Button type="submit" variant="outline" disabled={grant.isPending}>
                Grant
              </Button>
            </form>
          ) : null}
        </CardContent>
      </Card>

      {/*
        Estimated spend sits below the plan and credits deliberately: a
        customer should see both, with the distinction stated above, rather
        than finding them on separate pages where they are easy to conflate.
      */}
      <UsageAndBudgets />

      {!canManage ? (
        <Card>
          <CardContent className="flex items-start gap-3 pt-6 text-sm text-muted-foreground">
            <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
            <p>
              Changing the plan or granting credits needs the{' '}
              <code className="rounded bg-muted px-1">org:billing:manage</code> permission.
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
