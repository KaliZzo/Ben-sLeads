-- AlterEnum
ALTER TYPE "LeadStatus" ADD VALUE 'NEEDS_HUMAN';

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "callbackAt" TIMESTAMP(3),
ADD COLUMN     "followUpReason" TEXT;

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "agentVersion" TEXT,
ADD COLUMN     "metrics" JSONB,
ADD COLUMN     "turnLatencyMs" INTEGER;
