-- AlterTable
ALTER TABLE "AudioStory" ADD COLUMN     "analysisResult" JSONB,
ADD COLUMN     "analyzedAt" TIMESTAMP(3);
