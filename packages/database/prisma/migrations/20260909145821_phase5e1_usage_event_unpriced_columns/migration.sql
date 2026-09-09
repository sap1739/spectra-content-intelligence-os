-- AlterTable
ALTER TABLE "usage_events" ADD COLUMN     "quantityUnknown" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rateSource" "RateSource",
ADD COLUMN     "unpricedReason" "UnpricedReason";

