-- CreateTable
CREATE TABLE "AnimationProject" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "width" INTEGER NOT NULL DEFAULT 1920,
    "height" INTEGER NOT NULL DEFAULT 1080,
    "fps" INTEGER NOT NULL DEFAULT 24,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnimationProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnimationScene" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 5000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnimationScene_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnimationProject_userId_idx" ON "AnimationProject"("userId");

-- CreateIndex
CREATE INDEX "AnimationScene_projectId_sortOrder_idx" ON "AnimationScene"("projectId", "sortOrder");

-- AddForeignKey
ALTER TABLE "AnimationProject" ADD CONSTRAINT "AnimationProject_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnimationScene" ADD CONSTRAINT "AnimationScene_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "AnimationProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
