CREATE TABLE "StorageObject" (
  "id" TEXT NOT NULL,
  "location" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'UPLOADING',
  "nextCleanupAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StorageObject_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StorageObject_location_key" ON "StorageObject"("location");
CREATE INDEX "StorageObject_status_nextCleanupAt_idx" ON "StorageObject"("status", "nextCleanupAt");
CREATE INDEX "SceneAudio_filePath_idx" ON "SceneAudio"("filePath");
CREATE INDEX "AudioAsset_filePath_idx" ON "AudioAsset"("filePath");
