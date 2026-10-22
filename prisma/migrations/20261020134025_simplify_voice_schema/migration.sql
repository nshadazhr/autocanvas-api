/*
  Warnings:

  - You are about to drop the column `ageCategory` on the `Voice` table. All the data in the column will be lost.
  - You are about to drop the column `languages` on the `Voice` table. All the data in the column will be lost.
  - You are about to drop the column `style` on the `Voice` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[provider,providerVoiceId]` on the table `Voice` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `model` to the `Voice` table without a default value. This is not possible if the table is not empty.
  - Added the required column `provider` to the `Voice` table without a default value. This is not possible if the table is not empty.
  - Added the required column `providerVoiceId` to the `Voice` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Voice" DROP COLUMN "ageCategory",
DROP COLUMN "languages",
DROP COLUMN "style",
ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "model" TEXT NOT NULL,
ADD COLUMN     "provider" TEXT NOT NULL,
ADD COLUMN     "providerVoiceId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "Voice_provider_idx" ON "Voice"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "Voice_provider_providerVoiceId_key" ON "Voice"("provider", "providerVoiceId");
