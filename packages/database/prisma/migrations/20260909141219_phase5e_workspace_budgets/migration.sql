-- CreateEnum
CREATE TYPE "BudgetEnforcement" AS ENUM ('OFF', 'WARN', 'ENFORCE');

-- CreateTable
CREATE TABLE "workspace_budgets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "enforcement" "BudgetEnforcement" NOT NULL DEFAULT 'WARN',
    "monthlyLimitMicros" INTEGER,
    "warnAtPercent" INTEGER NOT NULL DEFAULT 80,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "updatedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workspace_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_budgets_workspaceId_key" ON "workspace_budgets"("workspaceId");

-- CreateIndex
CREATE INDEX "workspace_budgets_organizationId_idx" ON "workspace_budgets"("organizationId");

-- AddForeignKey
ALTER TABLE "workspace_budgets" ADD CONSTRAINT "workspace_budgets_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_budgets" ADD CONSTRAINT "workspace_budgets_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_budgets" ADD CONSTRAINT "workspace_budgets_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

