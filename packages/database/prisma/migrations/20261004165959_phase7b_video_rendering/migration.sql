-- CreateEnum
CREATE TYPE "VideoProjectKind" AS ENUM ('SLIDESHOW', 'VERTICAL_SHORT', 'SQUARE_SOCIAL', 'LANDSCAPE', 'CAPTIONED', 'AUDIOGRAM');

-- CreateEnum
CREATE TYPE "VideoProjectStatus" AS ENUM ('DRAFT', 'READY', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "VideoRenderStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "VideoFailureReason" AS ENUM ('ENGINE_NOT_CONFIGURED', 'ENGINE_MISSING_CAPABILITY', 'INPUT_UNAVAILABLE', 'INPUT_UNSUPPORTED', 'INVALID_STORYBOARD', 'ENGINE_ERROR', 'TIMEOUT', 'CANCELLED', 'STORAGE_ERROR', 'BUDGET_REFUSED', 'WORKER_LOST');

-- CreateTable
CREATE TABLE "video_projects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" "VideoProjectKind" NOT NULL,
    "status" "VideoProjectStatus" NOT NULL DEFAULT 'DRAFT',
    "formatKey" TEXT NOT NULL,
    "storyboard" JSONB NOT NULL,
    "brandId" UUID,
    "contentItemId" UUID,
    "campaignId" UUID,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "video_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_renders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "status" "VideoRenderStatus" NOT NULL DEFAULT 'QUEUED',
    "formatKey" TEXT NOT NULL,
    "storyboard" JSONB NOT NULL,
    "crf" INTEGER NOT NULL,
    "captions" TEXT NOT NULL,
    "thumbnail" BOOLEAN NOT NULL DEFAULT true,
    "renderHash" TEXT NOT NULL,
    "renderKey" TEXT NOT NULL,
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "plannedDurationMs" INTEGER NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "queueJobId" TEXT,
    "cancelRequestedAt" TIMESTAMPTZ(6),
    "startedAt" TIMESTAMPTZ(6),
    "finishedAt" TIMESTAMPTZ(6),
    "failureReason" "VideoFailureReason",
    "failureDetail" TEXT,
    "engine" TEXT,
    "engineVersion" TEXT,
    "videoCodec" TEXT,
    "durationMs" INTEGER,
    "widthPx" INTEGER,
    "heightPx" INTEGER,
    "sizeBytes" INTEGER,
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mediaAssetId" UUID,
    "captionAssetId" UUID,
    "thumbnailAssetId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "video_renders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "video_projects_workspaceId_status_updatedAt_idx" ON "video_projects"("workspaceId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "video_projects_contentItemId_idx" ON "video_projects"("contentItemId");

-- CreateIndex
CREATE INDEX "video_projects_campaignId_idx" ON "video_projects"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "video_renders_renderKey_key" ON "video_renders"("renderKey");

-- CreateIndex
CREATE UNIQUE INDEX "video_renders_mediaAssetId_key" ON "video_renders"("mediaAssetId");

-- CreateIndex
CREATE INDEX "video_renders_projectId_createdAt_idx" ON "video_renders"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "video_renders_workspaceId_status_createdAt_idx" ON "video_renders"("workspaceId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "video_projects" ADD CONSTRAINT "video_projects_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_projects" ADD CONSTRAINT "video_projects_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_projects" ADD CONSTRAINT "video_projects_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_projects" ADD CONSTRAINT "video_projects_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "content_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_projects" ADD CONSTRAINT "video_projects_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_renders" ADD CONSTRAINT "video_renders_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_renders" ADD CONSTRAINT "video_renders_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_renders" ADD CONSTRAINT "video_renders_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "video_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_renders" ADD CONSTRAINT "video_renders_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_renders" ADD CONSTRAINT "video_renders_captionAssetId_fkey" FOREIGN KEY ("captionAssetId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_renders" ADD CONSTRAINT "video_renders_thumbnailAssetId_fkey" FOREIGN KEY ("thumbnailAssetId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
