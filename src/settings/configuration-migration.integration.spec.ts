import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
const url = process.env.AUDIO_FLOW_TEST_DATABASE_URL;
if (url && (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname) || !new URL(url).pathname.endsWith('_test')))
	throw new Error('Disposable local test DB required');
describe.skipIf(!url)('Configuration migration', () => {
	it('preserves populated legacy rows, false values, locales, provider siblings and timestamps', async () => {
		const client = new Client({ connectionString: url });
		const schema = 'configuration_migration_' + randomUUID().replaceAll('-', '');
		await client.connect();
		try {
			await client.query(`CREATE SCHEMA "${schema}"`);
			await client.query(`SET search_path TO "${schema}"`);
			await client.query(
				'CREATE TABLE "AppSetting" (key TEXT CONSTRAINT "AppSetting_pkey" PRIMARY KEY, value TEXT NOT NULL, "updatedAt" TIMESTAMP(3) NOT NULL)'
			);
			const legacy = {
				'analysis.gemini.model': 'fixture-model',
				'credentials.gemini.managed': 'true',
				'runtime.models': '{"outlineModel":"fixture-outline"}',
				'runtime.features': '{"audioEnabled":false,"geminiEnabled":false,"openaiEnabled":true}',
				'runtime.processing': '{"maxRecoveryAttempts":5}',
				'runtime.pricing': '{"analysisCredits":4}',
				'runtime.web-settings': '{"nested":{"list":[1,false,null]}}',
				'web.strings.en': '{"label":"English"}',
				'web.strings.hi': '{"label":"हिन्दी"}',
				custom_legacy: 'plain-value'
			};
			for (const [key, value] of Object.entries(legacy))
				await client.query('INSERT INTO "AppSetting" VALUES ($1,$2,$3)', [key, value, '2026-10-25T00:00:00Z']);
			await client.query(
				readFileSync('prisma/migrations/20261026060000_configuration_groups/migration.sql', 'utf8')
			);
			const rows = (await client.query(`SELECT *, to_char("updatedAt", 'YYYY-MM-DD HH24:MI:SS.MS') AS timestamp_text FROM "Configuration"`)).rows;
			const values = Object.fromEntries(rows.map(row => [row.key, row.value]));
			expect(values.gemini_settings).toEqual({
				analysisModel: 'fixture-model',
				credentialMode: 'dashboard',
				enabled: false
			});
			expect(values.openai_settings).toEqual({ outlineModel: 'fixture-outline', enabled: true });
			expect(values.backend_settings).toEqual({
				features: { audioEnabled: false },
				processing: { maxRecoveryAttempts: 5 }
			});
			expect(values.app_strings).toEqual({ en: { label: 'English' }, hi: { label: 'हिन्दी' } });
			expect(values.app_settings).toEqual({ nested: { list: [1, false, null] } });
			expect(values.credits_settings).toEqual({ analysisCredits: 4 });
			expect(values.custom_legacy).toBe('plain-value');
			expect(rows).toHaveLength(7);
			expect(rows.every(row => row.timestamp_text === '2026-10-25 00:00:00.000')).toBe(true);
		} finally {
			await client.query('ROLLBACK');
			await client.query('SET search_path TO public');
			await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
			await client.end();
		}
	});
});
