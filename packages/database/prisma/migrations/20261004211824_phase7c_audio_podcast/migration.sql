-- CreateEnum
CREATE TYPE "VoiceKind" AS ENUM ('STOCK', 'CLONED', 'CUSTOM_SYNTHETIC');

-- CreateEnum
CREATE TYPE "VoiceConsentStatus" AS ENUM ('PENDING', 'GRANTED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "VoiceConsentScope" AS ENUM ('INTERNAL_ONLY', 'ORGANIC_SOCIAL', 'PODCAST', 'MARKETING', 'PAID_ADVERTISING');

-- CreateEnum
CREATE TYPE "PodcastEpisodeStatus" AS ENUM ('DRAFT', 'READY_TO_RENDER', 'RENDERING', 'READY', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AudioRenderKind" AS ENUM ('EPISODE_MIX', 'WAVEFORM', 'AUDIOGRAM');

-- CreateEnum
CREATE TYPE "AudioRenderStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "AudioFailureReason" AS ENUM ('ENGINE_NOT_CONFIGURED', 'ENGINE_MISSING_CAPABILITY', 'TTS_NOT_CONFIGURED', 'VOICE_CONSENT_MISSING', 'INPUT_UNAVAILABLE', 'INPUT_UNSUPPORTED', 'INVALID_SCRIPT', 'ENGINE_ERROR', 'TIMEOUT', 'CANCELLED', 'STORAGE_ERROR', 'BUDGET_REFUSED', 'WORKER_LOST');

-- CreateEnum
CREATE TYPE "TranscriptSource" AS ENUM ('AUTHORED', 'SCRIPT_DERIVED', 'MACHINE_TRANSCRIBED');

-- CreateTable
CREATE TABLE "voice_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "VoiceKind" NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "description" TEXT,
    "providerId" TEXT,
    "providerVoiceId" TEXT,
    "subjectName" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "voice_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_consent_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "voiceProfileId" UUID NOT NULL,
    "subjectName" TEXT NOT NULL,
    "subjectEmail" TEXT,
    "method" TEXT NOT NULL,
    "evidenceAssetId" UUID,
    "reference" TEXT,
    "scopes" "VoiceConsentScope"[],
    "status" "VoiceConsentStatus" NOT NULL DEFAULT 'PENDING',
    "grantedAt" TIMESTAMPTZ(6),
    "expiresAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "revokedReason" TEXT,
    "obtainedByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "voice_consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "podcast_episodes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "showNotes" TEXT,
    "seasonNumber" INTEGER,
    "episodeNumber" INTEGER,
    "status" "PodcastEpisodeStatus" NOT NULL DEFAULT 'DRAFT',
    "script" JSONB NOT NULL,
    "consentScope" "VoiceConsentScope" NOT NULL DEFAULT 'PODCAST',
    "audioAssetId" UUID,
    "durationMs" INTEGER,
    "integratedLufs" DOUBLE PRECISION,
    "contentItemId" UUID,
    "campaignId" UUID,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "podcast_episodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcripts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "episodeId" UUID,
    "audioAssetId" UUID,
    "source" "TranscriptSource" NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "cues" JSONB NOT NULL,
    "modelRef" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audio_renders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "episodeId" UUID NOT NULL,
    "kind" "AudioRenderKind" NOT NULL DEFAULT 'EPISODE_MIX',
    "status" "AudioRenderStatus" NOT NULL DEFAULT 'QUEUED',
    "script" JSONB NOT NULL,
    "audiogram" JSONB,
    "renderHash" TEXT NOT NULL,
    "renderKey" TEXT NOT NULL,
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "queueJobId" TEXT,
    "cancelRequestedAt" TIMESTAMPTZ(6),
    "startedAt" TIMESTAMPTZ(6),
    "finishedAt" TIMESTAMPTZ(6),
    "failureReason" "AudioFailureReason",
    "failureDetail" TEXT,
    "engine" TEXT,
    "engineVersion" TEXT,
    "audioCodec" TEXT,
    "durationMs" INTEGER,
    "sizeBytes" INTEGER,
    "integratedLufs" DOUBLE PRECISION,
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mediaAssetId" UUID,
    "waveformAssetId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "audio_renders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "voice_profiles_workspaceId_kind_idx" ON "voice_profiles"("workspaceId", "kind");

-- CreateIndex
CREATE INDEX "voice_consent_records_voiceProfileId_status_idx" ON "voice_consent_records"("voiceProfileId", "status");

-- CreateIndex
CREATE INDEX "voice_consent_records_workspaceId_status_idx" ON "voice_consent_records"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "podcast_episodes_workspaceId_status_updatedAt_idx" ON "podcast_episodes"("workspaceId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "podcast_episodes_contentItemId_idx" ON "podcast_episodes"("contentItemId");

-- CreateIndex
CREATE INDEX "transcripts_workspaceId_createdAt_idx" ON "transcripts"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "transcripts_episodeId_idx" ON "transcripts"("episodeId");

-- CreateIndex
CREATE UNIQUE INDEX "audio_renders_renderKey_key" ON "audio_renders"("renderKey");

-- CreateIndex
CREATE UNIQUE INDEX "audio_renders_mediaAssetId_key" ON "audio_renders"("mediaAssetId");

-- CreateIndex
CREATE INDEX "audio_renders_episodeId_createdAt_idx" ON "audio_renders"("episodeId", "createdAt");

-- CreateIndex
CREATE INDEX "audio_renders_workspaceId_status_createdAt_idx" ON "audio_renders"("workspaceId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "voice_profiles" ADD CONSTRAINT "voice_profiles_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_profiles" ADD CONSTRAINT "voice_profiles_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_consent_records" ADD CONSTRAINT "voice_consent_records_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_consent_records" ADD CONSTRAINT "voice_consent_records_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_consent_records" ADD CONSTRAINT "voice_consent_records_voiceProfileId_fkey" FOREIGN KEY ("voiceProfileId") REFERENCES "voice_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_consent_records" ADD CONSTRAINT "voice_consent_records_evidenceAssetId_fkey" FOREIGN KEY ("evidenceAssetId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "podcast_episodes" ADD CONSTRAINT "podcast_episodes_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "podcast_episodes" ADD CONSTRAINT "podcast_episodes_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "podcast_episodes" ADD CONSTRAINT "podcast_episodes_audioAssetId_fkey" FOREIGN KEY ("audioAssetId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "podcast_episodes" ADD CONSTRAINT "podcast_episodes_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "content_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "podcast_episodes" ADD CONSTRAINT "podcast_episodes_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "podcast_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_renders" ADD CONSTRAINT "audio_renders_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_renders" ADD CONSTRAINT "audio_renders_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_renders" ADD CONSTRAINT "audio_renders_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "podcast_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_renders" ADD CONSTRAINT "audio_renders_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_renders" ADD CONSTRAINT "audio_renders_waveformAssetId_fkey" FOREIGN KEY ("waveformAssetId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
