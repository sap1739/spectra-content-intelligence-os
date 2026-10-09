-- CreateEnum
CREATE TYPE "BillingMode" AS ENUM ('TEST', 'LIVE');

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('FREE', 'STARTER', 'GROWTH', 'SCALE', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('MONTH', 'YEAR');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('INCOMPLETE', 'INCOMPLETE_EXPIRED', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'UNPAID', 'PAUSED');

-- CreateEnum
CREATE TYPE "CreditSource" AS ENUM ('MONTHLY_ALLOWANCE', 'PURCHASED', 'MANUAL', 'REVERSAL');

-- CreateEnum
CREATE TYPE "CreditEntryKind" AS ENUM ('GRANT', 'CONSUMPTION', 'REVERSAL', 'EXPIRY');

-- CreateEnum
CREATE TYPE "WebhookProcessingStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "tier" "PlanTier" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "monthlyCredits" INTEGER NOT NULL DEFAULT 0,
    "entitlements" JSONB NOT NULL,
    "selfServe" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_prices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "planId" UUID NOT NULL,
    "mode" "BillingMode" NOT NULL,
    "providerPriceId" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "unitAmount" INTEGER NOT NULL,
    "interval" "BillingInterval" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_customers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "mode" "BillingMode" NOT NULL,
    "providerCustomerId" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "billing_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "mode" "BillingMode" NOT NULL,
    "providerSubscriptionId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "currentPeriodStart" TIMESTAMPTZ(6),
    "currentPeriodEnd" TIMESTAMPTZ(6),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "canceledAt" TIMESTAMPTZ(6),
    "trialEndsAt" TIMESTAMPTZ(6),
    "lastPaymentFailedAt" TIMESTAMPTZ(6),
    "lastPaymentFailureMessage" TEXT,
    "lastEventId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_grants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "source" "CreditSource" NOT NULL,
    "amount" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "expiresAt" TIMESTAMPTZ(6),
    "grantedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedByUserId" UUID,
    "reason" TEXT,
    "providerReference" TEXT,
    "grantKey" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "credit_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_ledger_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "grantId" UUID,
    "kind" "CreditEntryKind" NOT NULL,
    "amount" INTEGER NOT NULL,
    "resourceType" TEXT,
    "resourceId" UUID,
    "idempotencyKey" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_webhook_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "mode" "BillingMode" NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "WebhookProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "organizationId" UUID,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(6),
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "billing_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_key_key" ON "plans"("key");

-- CreateIndex
CREATE INDEX "plans_active_sortOrder_idx" ON "plans"("active", "sortOrder");

-- CreateIndex
CREATE INDEX "product_prices_planId_mode_active_idx" ON "product_prices"("planId", "mode", "active");

-- CreateIndex
CREATE UNIQUE INDEX "product_prices_mode_providerPriceId_key" ON "product_prices"("mode", "providerPriceId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_customers_organizationId_mode_key" ON "billing_customers"("organizationId", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "billing_customers_mode_providerCustomerId_key" ON "billing_customers"("mode", "providerCustomerId");

-- CreateIndex
CREATE INDEX "subscriptions_organizationId_mode_status_idx" ON "subscriptions"("organizationId", "mode", "status");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_mode_providerSubscriptionId_key" ON "subscriptions"("mode", "providerSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_grants_grantKey_key" ON "credit_grants"("grantKey");

-- CreateIndex
CREATE INDEX "credit_grants_organizationId_expiresAt_idx" ON "credit_grants"("organizationId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "credit_ledger_entries_idempotencyKey_key" ON "credit_ledger_entries"("idempotencyKey");

-- CreateIndex
CREATE INDEX "credit_ledger_entries_organizationId_createdAt_idx" ON "credit_ledger_entries"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "billing_webhook_events_status_receivedAt_idx" ON "billing_webhook_events"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "billing_webhook_events_mode_providerEventId_key" ON "billing_webhook_events"("mode", "providerEventId");

-- AddForeignKey
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "credit_grants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
