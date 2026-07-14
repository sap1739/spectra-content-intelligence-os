-- CreateEnum
CREATE TYPE "SocialPlatform" AS ENUM ('LINKEDIN', 'INSTAGRAM', 'FACEBOOK', 'YOUTUBE', 'TIKTOK', 'THREADS', 'X', 'PINTEREST', 'WORDPRESS', 'EMAIL');

-- CreateEnum
CREATE TYPE "SocialAccountStatus" AS ENUM ('PENDING', 'CONNECTED', 'EXPIRED', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "SocialAccountKind" AS ENUM ('PROFILE', 'PAGE', 'CHANNEL', 'BUSINESS_ACCOUNT', 'SITE');

-- CreateTable
CREATE TABLE "social_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "kind" "SocialAccountKind" NOT NULL DEFAULT 'PROFILE',
    "status" "SocialAccountStatus" NOT NULL DEFAULT 'PENDING',
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tokenRef" TEXT,
    "encryptedToken" TEXT,
    "connectedById" UUID,
    "connectedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRefreshedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "social_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "social_accounts_workspaceId_platform_idx" ON "social_accounts"("workspaceId", "platform");

-- AddForeignKey
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
