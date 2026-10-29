BEGIN;
ALTER TABLE "AppSetting" RENAME TO "Configuration";
ALTER TABLE "Configuration" RENAME CONSTRAINT "AppSetting_pkey" TO "Configuration_pkey";
ALTER TABLE "Configuration" ALTER COLUMN "value" TYPE JSONB USING CASE
 WHEN "key" = 'analysis.gemini.model' THEN to_jsonb("value")
 WHEN "key" LIKE 'runtime.%' OR "key" LIKE 'web.strings.%' OR "key" LIKE 'credentials.%' THEN "value"::jsonb
 ELSE to_jsonb("value") END;
CREATE TEMP TABLE config_group_migration ON COMMIT DROP AS
SELECT CASE
 WHEN key LIKE 'web.strings.%' THEN 'app_strings'
 WHEN key = 'runtime.web-settings' THEN 'app_settings'
 WHEN key IN ('runtime.features','runtime.processing') THEN 'backend_settings'
 WHEN key IN ('analysis.gemini.model','credentials.gemini.managed') THEN 'gemini_settings'
 WHEN key IN ('runtime.models','credentials.openai.managed') THEN 'openai_settings'
 WHEN key = 'runtime.pricing' THEN 'credits_settings' ELSE key END AS new_key,
CASE
 WHEN key LIKE 'web.strings.%' THEN jsonb_build_object(substring(key from 13), value)
 WHEN key = 'runtime.features' THEN jsonb_build_object('features', value - 'geminiEnabled' - 'openaiEnabled')
 WHEN key = 'runtime.processing' THEN jsonb_build_object('processing', value)
 WHEN key = 'analysis.gemini.model' THEN jsonb_build_object('analysisModel', value)
 WHEN key IN ('credentials.gemini.managed','credentials.openai.managed') THEN
 jsonb_build_object('credentialMode', CASE WHEN value = 'true'::jsonb THEN 'dashboard' ELSE 'environment' END)
 ELSE value END AS payload, "updatedAt", key AS old_key FROM "Configuration";
INSERT INTO config_group_migration (new_key,payload,"updatedAt",old_key)
SELECT 'gemini_settings', jsonb_build_object('enabled',value->'geminiEnabled'), "updatedAt", key
FROM "Configuration" WHERE key='runtime.features' AND value ? 'geminiEnabled';
INSERT INTO config_group_migration (new_key,payload,"updatedAt",old_key)
SELECT 'openai_settings', jsonb_build_object('enabled',value->'openaiEnabled'), "updatedAt", key
FROM "Configuration" WHERE key='runtime.features' AND value ? 'openaiEnabled';
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM config_group_migration WHERE new_key <> old_key AND new_key IN (SELECT key FROM "Configuration")) THEN
 RAISE EXCEPTION 'Configuration target group already exists; reconcile before migration'; END IF;
END $$;
DELETE FROM "Configuration" WHERE key IN (SELECT old_key FROM config_group_migration WHERE old_key <> new_key);
INSERT INTO "Configuration" (key,value,"updatedAt")
SELECT new_key, jsonb_object_agg(entry.key, entry.value), max("updatedAt")
FROM config_group_migration CROSS JOIN LATERAL jsonb_each(payload) entry
WHERE old_key <> new_key GROUP BY new_key;
-- Preserve empty renamed groups too.
INSERT INTO "Configuration" (key,value,"updatedAt")
SELECT new_key, '{}'::jsonb, max("updatedAt") FROM config_group_migration
WHERE old_key <> new_key GROUP BY new_key ON CONFLICT (key) DO NOTHING;
COMMIT;
