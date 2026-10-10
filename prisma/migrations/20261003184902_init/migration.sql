-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('PENDING', 'CALLING', 'BOOKED', 'NOT_INTERESTED', 'DO_NOT_CALL', 'UNREACHABLE');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('QUEUED', 'IN_PROGRESS', 'ENDED', 'FAILED');

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "timezone" TEXT NOT NULL,
    "consent" BOOLEAN NOT NULL,
    "importNotes" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCallAt" TIMESTAMP(3),
    "meetingAt" TIMESTAMP(3),
    "customerName" TEXT,
    "email" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "notInterestedReason" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "sinkRevision" INTEGER NOT NULL DEFAULT 0,
    "sinkRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Call" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerCallId" TEXT,
    "status" "CallStatus" NOT NULL DEFAULT 'QUEUED',
    "endedReason" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "summary" TEXT,
    "transcript" TEXT,
    "recordingUrl" TEXT,
    "outcome" JSONB,

    CONSTRAINT "Call_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Lead_phone_key" ON "Lead"("phone");

-- CreateIndex
CREATE INDEX "Lead_status_nextAttemptAt_idx" ON "Lead"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "Call_providerCallId_key" ON "Call"("providerCallId");

-- CreateIndex
CREATE INDEX "Call_status_startedAt_idx" ON "Call"("status", "startedAt");

-- CreateIndex
CREATE INDEX "Call_leadId_idx" ON "Call"("leadId");

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
