CREATE TABLE "ProviderCredential" (
 "id" TEXT NOT NULL, "provider" TEXT NOT NULL, "name" TEXT NOT NULL, "encrypted" TEXT NOT NULL,
 "fingerprint" TEXT NOT NULL, "suffix" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT true,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ProviderCredential_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProviderCredential_provider_fingerprint_key" ON "ProviderCredential"("provider", "fingerprint");
CREATE INDEX "ProviderCredential_provider_enabled_idx" ON "ProviderCredential"("provider", "enabled");
