-- CreateEnum
CREATE TYPE "AudioAnalysisStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "AudioJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AudioJobItemStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED');

-- CreateTable
CREATE TABLE "AudioStory" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "userId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "analysisStatus" "AudioAnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "analysisError" TEXT,
    "analyzed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudioStory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioCharacter" (
    "id" SERIAL NOT NULL,
    "storyId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "gender" TEXT,
    "voiceId" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudioCharacter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioScene" (
    "id" SERIAL NOT NULL,
    "storyId" INTEGER NOT NULL,
    "characterId" INTEGER,
    "sceneOrder" INTEGER NOT NULL,
    "externalSceneId" TEXT,
    "title" TEXT,
    "speakerName" TEXT,
    "text" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'hi',
    "emotion" TEXT,
    "style" TEXT,
    "voiceOverrideId" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudioScene_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Voice" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "gender" TEXT,
    "ageCategory" TEXT,
    "description" TEXT,
    "style" TEXT,
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "previewUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Voice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceProviderMapping" (
    "id" SERIAL NOT NULL,
    "voiceId" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "providerVoiceId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "settings" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceProviderMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioGenerationJob" (
    "id" SERIAL NOT NULL,
    "storyId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "status" "AudioJobStatus" NOT NULL DEFAULT 'PENDING',
    "totalScenes" INTEGER NOT NULL DEFAULT 0,
    "completedScenes" INTEGER NOT NULL DEFAULT 0,
    "failedScenes" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudioGenerationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioGenerationJobItem" (
    "id" SERIAL NOT NULL,
    "jobId" INTEGER NOT NULL,
    "sceneId" INTEGER NOT NULL,
    "storyId" INTEGER NOT NULL,
    "status" "AudioJobItemStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "textSnapshot" TEXT,
    "voiceIdSnapshot" INTEGER,
    "settingsSnapshot" JSONB,
    "nextRetryAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudioGenerationJobItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SceneAudio" (
    "id" SERIAL NOT NULL,
    "sceneId" INTEGER NOT NULL,
    "jobItemId" INTEGER,
    "voiceId" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "providerVoiceId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "textSnapshot" TEXT NOT NULL,
    "settingsSnapshot" JSONB,
    "filePath" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'wav',
    "durationMs" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fileSizeBytes" BIGINT,
    "mimeType" TEXT,

    CONSTRAINT "SceneAudio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioAsset" (
    "id" SERIAL NOT NULL,
    "storyId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'wav',
    "durationMs" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fileSizeBytes" BIGINT,
    "mimeType" TEXT,

    CONSTRAINT "AudioAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AudioStory_userId_idx" ON "AudioStory"("userId");

-- CreateIndex
CREATE INDEX "AudioCharacter_voiceId_idx" ON "AudioCharacter"("voiceId");

-- CreateIndex
CREATE UNIQUE INDEX "AudioCharacter_storyId_name_key" ON "AudioCharacter"("storyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "AudioCharacter_id_storyId_key" ON "AudioCharacter"("id", "storyId");

-- CreateIndex
CREATE INDEX "AudioScene_characterId_storyId_idx" ON "AudioScene"("characterId", "storyId");

-- CreateIndex
CREATE INDEX "AudioScene_voiceOverrideId_idx" ON "AudioScene"("voiceOverrideId");

-- CreateIndex
CREATE UNIQUE INDEX "AudioScene_storyId_sceneOrder_key" ON "AudioScene"("storyId", "sceneOrder");

-- CreateIndex
CREATE UNIQUE INDEX "AudioScene_id_storyId_key" ON "AudioScene"("id", "storyId");

-- CreateIndex
CREATE INDEX "Voice_isActive_idx" ON "Voice"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "VoiceProviderMapping_voiceId_key" ON "VoiceProviderMapping"("voiceId");

-- CreateIndex
CREATE INDEX "VoiceProviderMapping_provider_idx" ON "VoiceProviderMapping"("provider");

-- CreateIndex
CREATE INDEX "AudioGenerationJob_storyId_idx" ON "AudioGenerationJob"("storyId");

-- CreateIndex
CREATE INDEX "AudioGenerationJob_userId_status_idx" ON "AudioGenerationJob"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AudioGenerationJob_id_storyId_key" ON "AudioGenerationJob"("id", "storyId");

-- CreateIndex
CREATE INDEX "AudioGenerationJobItem_status_nextRetryAt_idx" ON "AudioGenerationJobItem"("status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "AudioGenerationJobItem_sceneId_storyId_idx" ON "AudioGenerationJobItem"("sceneId", "storyId");

-- CreateIndex
CREATE UNIQUE INDEX "AudioGenerationJobItem_jobId_sceneId_key" ON "AudioGenerationJobItem"("jobId", "sceneId");

-- CreateIndex
CREATE UNIQUE INDEX "SceneAudio_jobItemId_key" ON "SceneAudio"("jobItemId");

-- CreateIndex
CREATE INDEX "SceneAudio_sceneId_idx" ON "SceneAudio"("sceneId");

-- CreateIndex
CREATE INDEX "SceneAudio_voiceId_idx" ON "SceneAudio"("voiceId");

-- CreateIndex
CREATE INDEX "AudioAsset_storyId_idx" ON "AudioAsset"("storyId");

-- AddForeignKey
ALTER TABLE "AudioStory" ADD CONSTRAINT "AudioStory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioCharacter" ADD CONSTRAINT "AudioCharacter_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "AudioStory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioCharacter" ADD CONSTRAINT "AudioCharacter_voiceId_fkey" FOREIGN KEY ("voiceId") REFERENCES "Voice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioScene" ADD CONSTRAINT "AudioScene_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "AudioStory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioScene" ADD CONSTRAINT "AudioScene_characterId_storyId_fkey" FOREIGN KEY ("characterId", "storyId") REFERENCES "AudioCharacter"("id", "storyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioScene" ADD CONSTRAINT "AudioScene_voiceOverrideId_fkey" FOREIGN KEY ("voiceOverrideId") REFERENCES "Voice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceProviderMapping" ADD CONSTRAINT "VoiceProviderMapping_voiceId_fkey" FOREIGN KEY ("voiceId") REFERENCES "Voice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioGenerationJob" ADD CONSTRAINT "AudioGenerationJob_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "AudioStory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioGenerationJob" ADD CONSTRAINT "AudioGenerationJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioGenerationJobItem" ADD CONSTRAINT "AudioGenerationJobItem_jobId_storyId_fkey" FOREIGN KEY ("jobId", "storyId") REFERENCES "AudioGenerationJob"("id", "storyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioGenerationJobItem" ADD CONSTRAINT "AudioGenerationJobItem_sceneId_storyId_fkey" FOREIGN KEY ("sceneId", "storyId") REFERENCES "AudioScene"("id", "storyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SceneAudio" ADD CONSTRAINT "SceneAudio_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "AudioScene"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SceneAudio" ADD CONSTRAINT "SceneAudio_voiceId_fkey" FOREIGN KEY ("voiceId") REFERENCES "Voice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SceneAudio" ADD CONSTRAINT "SceneAudio_jobItemId_fkey" FOREIGN KEY ("jobItemId") REFERENCES "AudioGenerationJobItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioAsset" ADD CONSTRAINT "AudioAsset_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "AudioStory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
