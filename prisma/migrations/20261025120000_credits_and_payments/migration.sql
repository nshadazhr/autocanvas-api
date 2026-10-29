-- AlterTable
ALTER TABLE "User" ADD COLUMN     "creditBalance" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "creditWelcomeGranted" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "creditsBlocked" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "CreditTransaction" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "actorId" INTEGER,
    "storyId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditPack" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditPack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditPurchase" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "requestId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "packName" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "providerKeyId" TEXT NOT NULL,
    "orderId" TEXT,
    "paymentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CREATING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditTransaction_reference_key" ON "CreditTransaction"("reference");

-- CreateIndex
CREATE INDEX "CreditTransaction_userId_createdAt_id_idx" ON "CreditTransaction"("userId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CreditPurchase_orderId_key" ON "CreditPurchase"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditPurchase_paymentId_key" ON "CreditPurchase"("paymentId");

-- CreateIndex
CREATE INDEX "CreditPurchase_userId_createdAt_idx" ON "CreditPurchase"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditPurchase_userId_requestId_key" ON "CreditPurchase"("userId", "requestId");

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditPurchase" ADD CONSTRAINT "CreditPurchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Existing accounts are not silently awarded a newly configured signup promotion.
ALTER TABLE "User" ALTER COLUMN "creditWelcomeGranted" SET DEFAULT false;
ALTER TABLE "User" ADD CONSTRAINT "User_creditBalance_check" CHECK ("creditBalance" >= 0 AND "creditBalance" <= 2000000000);
ALTER TABLE "CreditPack" ADD CONSTRAINT "CreditPack_positive_check" CHECK ("credits" > 0 AND "amountPaise" >= 100);
ALTER TABLE "CreditPurchase" ADD CONSTRAINT "CreditPurchase_positive_check" CHECK ("credits" > 0 AND "amountPaise" >= 100 AND "currency" = 'INR');
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_status_check" CHECK ("status" IN ('RESERVED', 'COMPLETED', 'REFUNDED'));
