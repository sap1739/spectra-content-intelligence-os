-- CreateEnum
CREATE TYPE "SocialConnectionStatus" AS ENUM ('CONNECTED', 'EXPIRED', 'REAUTH_REQUIRED', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "AccountDiscoveryStatus" AS ENUM ('NOT_AVAILABLE', 'COMPLETE', 'FAILED');

-- CreateEnum
CREATE TYPE "OAuthAttemptMode" AS ENUM ('CONNECT', 'RECONNECT');

-- CreateEnum
CREATE TYPE "OAuthAttemptOutcome" AS ENUM ('CONNECTED', 'DENIED', 'FAILED');

-- AlterTable
ALTER TABLE "social_accounts" ADD COLUMN     "connectionId" UUID,
ADD COLUMN     "credentialKeyId" TEXT,
ADD COLUMN     "discoveryMetadata" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "social_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "status" "SocialConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
    "label" TEXT NOT NULL,
    "externalSubjectId" TEXT,
    "requestedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "grantedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "grantedScopesReported" BOOLEAN NOT NULL DEFAULT false,
    "encryptedCredential" TEXT,
    "credentialKeyId" TEXT,
    "hasRefreshToken" BOOLEAN NOT NULL DEFAULT false,
    "accessTokenExpiresAt" TIMESTAMPTZ(6),
    "refreshTokenExpiresAt" TIMESTAMPTZ(6),
    "lastRefreshedAt" TIMESTAMPTZ(6),
    "lastErrorCode" TEXT,
    "discoveryStatus" "AccountDiscoveryStatus" NOT NULL DEFAULT 'NOT_AVAILABLE',
    "discoveredAt" TIMESTAMPTZ(6),
    "connectedById" UUID,
    "connectedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "social_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_oauth_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "mode" "OAuthAttemptMode" NOT NULL DEFAULT 'CONNECT',
    "connectionId" UUID,
    "label" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "encryptedCodeVerifier" TEXT,
    "redirectUri" TEXT NOT NULL,
    "requestedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "returnPath" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "outcome" "OAuthAttemptOutcome",
    "failureCode" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_oauth_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "social_connections_workspaceId_platform_idx" ON "social_connections"("workspaceId", "platform");

-- CreateIndex
CREATE INDEX "social_connections_organizationId_credentialKeyId_idx" ON "social_connections"("organizationId", "credentialKeyId");

-- CreateIndex
CREATE UNIQUE INDEX "social_oauth_attempts_stateHash_key" ON "social_oauth_attempts"("stateHash");

-- CreateIndex
CREATE INDEX "social_oauth_attempts_organizationId_createdAt_idx" ON "social_oauth_attempts"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "social_oauth_attempts_expiresAt_idx" ON "social_oauth_attempts"("expiresAt");

-- CreateIndex
CREATE INDEX "social_accounts_connectionId_idx" ON "social_accounts"("connectionId");

-- AddForeignKey
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "social_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_oauth_attempts" ADD CONSTRAINT "social_oauth_attempts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_oauth_attempts" ADD CONSTRAINT "social_oauth_attempts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_oauth_attempts" ADD CONSTRAINT "social_oauth_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_oauth_attempts" ADD CONSTRAINT "social_oauth_attempts_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "social_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: record which key sealed each existing credential, read from the
-- ciphertext itself (`v1.<keyId>.<iv>.<tag>.<ct>`). Key ids are not secret;
-- this is what lets a rotation find rows still sealed under a retired key.
UPDATE "social_accounts"
SET "credentialKeyId" = split_part("encryptedToken", '.', 2)
WHERE "encryptedToken" IS NOT NULL
  AND split_part("encryptedToken", '.', 1) = 'v1'
  AND split_part("encryptedToken", '.', 2) <> '';
