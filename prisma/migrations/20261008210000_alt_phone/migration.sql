-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "altPhone" TEXT,
ADD COLUMN     "dialAltPhone" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "phone" TEXT;
