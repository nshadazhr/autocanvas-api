CREATE TYPE "StoryAnalysisJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'WAITING', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TABLE "StoryAnalysisJob" (
 "id" TEXT NOT NULL PRIMARY KEY, "storyId" INTEGER NOT NULL, "userId" INTEGER NOT NULL,
 "contentHash" TEXT NOT NULL, "contentSnapshot" TEXT NOT NULL,
 "status" "StoryAnalysisJobStatus" NOT NULL DEFAULT 'QUEUED', "attempts" INTEGER NOT NULL DEFAULT 0,
 "nextRetryAt" TIMESTAMP(3), "leaseToken" TEXT, "leaseExpiresAt" TIMESTAMP(3),
 "errorCode" TEXT, "errorMessage" TEXT, "source" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, "completedAt" TIMESTAMP(3),
 CONSTRAINT "StoryAnalysisJob_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "AudioStory"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "StoryAnalysisJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "StoryAnalysisJob_status_nextRetryAt_idx" ON "StoryAnalysisJob"("status", "nextRetryAt");
CREATE INDEX "StoryAnalysisJob_userId_status_idx" ON "StoryAnalysisJob"("userId", "status");
CREATE INDEX "StoryAnalysisJob_storyId_createdAt_idx" ON "StoryAnalysisJob"("storyId", "createdAt");
CREATE UNIQUE INDEX "StoryAnalysisJob_one_active_per_story" ON "StoryAnalysisJob"("storyId") WHERE "status" IN ('QUEUED', 'PROCESSING', 'WAITING');
CREATE TABLE "AiUsageBucket" ("key" TEXT NOT NULL PRIMARY KEY, "requests" INTEGER NOT NULL DEFAULT 0, "units" INTEGER NOT NULL DEFAULT 0, "expiresAt" TIMESTAMP(3) NOT NULL);
CREATE TABLE "AiRequestLease" ("id" TEXT NOT NULL PRIMARY KEY, "userId" INTEGER NOT NULL, "kind" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL);
CREATE INDEX "AiRequestLease_expiresAt_idx" ON "AiRequestLease"("expiresAt");
CREATE INDEX "AiRequestLease_userId_expiresAt_idx" ON "AiRequestLease"("userId", "expiresAt");
-- Legacy synchronous work cannot resume because it has no stored job snapshot.
UPDATE "AudioStory" SET "analysisStatus" = 'FAILED', "analysisError" = 'Analysis was interrupted by an upgrade. Please submit it again.', "analysisAttemptId" = NULL, "analysisStartedAt" = NULL WHERE "analysisStatus" = 'PROCESSING' AND "status" NOT LIKE 'SINGLE_%';
