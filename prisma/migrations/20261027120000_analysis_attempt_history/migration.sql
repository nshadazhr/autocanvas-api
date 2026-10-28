ALTER TABLE "StoryAnalysisJob" ADD COLUMN "resultSnapshot" JSONB,
ADD COLUMN "successfulProvider" TEXT, ADD COLUMN "successfulModel" TEXT;
CREATE TYPE "AnalysisAttemptStatus" AS ENUM ('RUNNING','COMPLETED','FAILED','CANCELLED','INTERRUPTED');
CREATE TYPE "AnalysisAttemptKind" AS ENUM ('INITIAL','MODEL_FALLBACK','PROVIDER_FALLBACK','PRIMARY_RETRY');
CREATE TABLE "StoryAnalysisAttempt" (
 "id" TEXT NOT NULL,
 "jobId" TEXT NOT NULL,
 "sequence" INTEGER NOT NULL,
 "provider" TEXT NOT NULL,
 "model" TEXT NOT NULL,
 "kind" "AnalysisAttemptKind" NOT NULL,
 "status" "AnalysisAttemptStatus" NOT NULL DEFAULT 'RUNNING',
 "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "responseAt" TIMESTAMP(3),
 "finishedAt" TIMESTAMP(3),
 "durationMs" INTEGER,
 "errorCategory" TEXT,
 "providerHttpStatus" INTEGER,
 "providerErrorCode" TEXT,
 "errorMessage" TEXT,
 CONSTRAINT "StoryAnalysisAttempt_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "StoryAnalysisAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "StoryAnalysisJob"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StoryAnalysisAttempt_jobId_sequence_key" ON "StoryAnalysisAttempt"("jobId","sequence");
CREATE INDEX "StoryAnalysisAttempt_provider_model_status_startedAt_idx" ON "StoryAnalysisAttempt"("provider","model","status","startedAt");
