-- CreateEnum
CREATE TYPE "DesignTemplateCategory" AS ENUM ('SOCIAL_POST', 'CAROUSEL', 'STORY', 'THUMBNAIL', 'FLYER', 'POSTER', 'BANNER', 'QUOTE');

-- CreateEnum
CREATE TYPE "DesignTemplateStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "DesignStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "DesignOutputFormat" AS ENUM ('PNG', 'JPEG', 'PDF');

-- AlterTable
ALTER TABLE "brands" ADD COLUMN     "logoAssetId" UUID,
ADD COLUMN     "offerings" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "palette" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "tagline" TEXT,
ADD COLUMN     "typography" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "visualStyle" TEXT;

-- CreateTable
CREATE TABLE "design_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" "DesignTemplateCategory" NOT NULL,
    "status" "DesignTemplateStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "layout" JSONB NOT NULL,
    "formats" TEXT[],
    "defaultFormat" TEXT NOT NULL,
    "sourceBuiltInKey" TEXT,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "design_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "designs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "templateId" UUID,
    "templateBuiltInKey" TEXT,
    "templateVersion" INTEGER NOT NULL,
    "category" "DesignTemplateCategory" NOT NULL,
    "layout" JSONB NOT NULL,
    "brandId" UUID,
    "formatKey" TEXT NOT NULL,
    "values" JSONB NOT NULL DEFAULT '{}',
    "images" JSONB NOT NULL DEFAULT '{}',
    "status" "DesignStatus" NOT NULL DEFAULT 'DRAFT',
    "contentItemId" UUID,
    "campaignId" UUID,
    "reviewNote" TEXT,
    "submittedAt" TIMESTAMPTZ(6),
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(6),
    "publishedAt" TIMESTAMPTZ(6),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "designs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "design_renders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "designId" UUID NOT NULL,
    "mediaAssetId" UUID NOT NULL,
    "outputFormat" "DesignOutputFormat" NOT NULL,
    "pageIndex" INTEGER,
    "pageCount" INTEGER NOT NULL,
    "formatKey" TEXT NOT NULL,
    "widthPx" INTEGER NOT NULL,
    "heightPx" INTEGER NOT NULL,
    "renderHash" TEXT NOT NULL,
    "renderKey" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "engineVersion" TEXT,
    "durationMs" INTEGER NOT NULL,
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "design_renders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "design_templates_workspaceId_status_category_idx" ON "design_templates"("workspaceId", "status", "category");

-- CreateIndex
CREATE INDEX "designs_workspaceId_status_updatedAt_idx" ON "designs"("workspaceId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "designs_contentItemId_idx" ON "designs"("contentItemId");

-- CreateIndex
CREATE INDEX "designs_campaignId_idx" ON "designs"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "design_renders_mediaAssetId_key" ON "design_renders"("mediaAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "design_renders_renderKey_key" ON "design_renders"("renderKey");

-- CreateIndex
CREATE INDEX "design_renders_designId_createdAt_idx" ON "design_renders"("designId", "createdAt");

-- AddForeignKey
ALTER TABLE "brands" ADD CONSTRAINT "brands_logoAssetId_fkey" FOREIGN KEY ("logoAssetId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_templates" ADD CONSTRAINT "design_templates_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_templates" ADD CONSTRAINT "design_templates_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "designs" ADD CONSTRAINT "designs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "designs" ADD CONSTRAINT "designs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "designs" ADD CONSTRAINT "designs_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "design_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "designs" ADD CONSTRAINT "designs_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "designs" ADD CONSTRAINT "designs_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "content_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "designs" ADD CONSTRAINT "designs_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_renders" ADD CONSTRAINT "design_renders_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_renders" ADD CONSTRAINT "design_renders_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_renders" ADD CONSTRAINT "design_renders_designId_fkey" FOREIGN KEY ("designId") REFERENCES "designs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_renders" ADD CONSTRAINT "design_renders_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
