-- Provider secrets are now managed only in backend environment configuration.
-- Intentionally delete saved credentials; preserve all non-secret provider settings.
BEGIN;
UPDATE "Configuration"
SET "value" = "value" - 'credentialMode', "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" IN ('gemini_settings', 'openai_settings') AND "value" ? 'credentialMode';
DROP TABLE "ProviderCredential";
COMMIT;
