-- AlterTable
ALTER TABLE "User" ADD COLUMN     "email_verified_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "EmailVerificationChallenge" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "otp_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailVerificationChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailVerificationChallenge_user_id_key" ON "EmailVerificationChallenge"("user_id");

-- CreateIndex
CREATE INDEX "EmailVerificationChallenge_expires_at_idx" ON "EmailVerificationChallenge"("expires_at");

-- AddForeignKey
ALTER TABLE "EmailVerificationChallenge" ADD CONSTRAINT "EmailVerificationChallenge_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
