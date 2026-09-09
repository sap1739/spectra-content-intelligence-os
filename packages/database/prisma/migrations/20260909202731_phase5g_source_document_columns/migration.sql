-- AlterTable
ALTER TABLE "research_sources" ADD COLUMN     "documentPageCount" INTEGER,
ADD COLUMN     "documentType" "ExtractedDocumentType",
ADD COLUMN     "extractionFailureCode" "DocumentExtractionFailureCode";

