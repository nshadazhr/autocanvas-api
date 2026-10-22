/*
  Warnings:

  - You are about to drop the `VoiceProviderMapping` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "VoiceProviderMapping" DROP CONSTRAINT "VoiceProviderMapping_voiceId_fkey";

-- AlterTable
ALTER TABLE "Voice" ADD COLUMN     "ageCategory" TEXT;

-- DropTable
DROP TABLE "VoiceProviderMapping";
