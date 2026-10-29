import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
const url = process.env.AUDIO_FLOW_TEST_DATABASE_URL;
if (url && (!['localhost', '127.0.0.1'].includes(new URL(url).hostname) || !new URL(url).pathname.endsWith('_test')))
	throw new Error('Disposable local test database required');
describe.skipIf(!url)('environment-only credential migration', () => {
	it('deletes saved credentials and source flags while preserving models, switches and other settings', async () => {
		const db = new Client({ connectionString: url });
		const schema = 'env_keys_' + randomUUID().replaceAll('-', '');
		await db.connect();
		try {
			await db.query(`CREATE SCHEMA "${schema}"`);
			await db.query(`SET search_path TO "${schema}"`);
			await db.query('CREATE TABLE "ProviderCredential" (id TEXT PRIMARY KEY, encrypted TEXT)');
			await db.query('INSERT INTO "ProviderCredential" VALUES ($1,$2)', ['fixture', 'fixture-old-ciphertext']);
			await db.query(
				'CREATE TABLE "Configuration" (key TEXT PRIMARY KEY, value JSONB NOT NULL, "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)'
			);
			const fixture = {
				gemini_settings: { analysisModel: 'fixture-gemini', enabled: false, credentialMode: 'dashboard' },
				openai_settings: { outlineModel: 'fixture-openai', credentialMode: 'dashboard', enabled: true },
				backend_settings: { processing: { maxRecoveryAttempts: 3 } }
			};
			for (const [key, value] of Object.entries(fixture))
				await db.query('INSERT INTO "Configuration" (key,value) VALUES ($1,$2)', [key, JSON.stringify(value)]);
			await db.query(
				readFileSync('prisma/migrations/20261028143000_env_only_provider_keys/migration.sql', 'utf8')
			);
			expect(
				(await db.query(`SELECT to_regclass('"ProviderCredential"') AS table_name`)).rows[0].table_name
			).toBeNull();
			const values = Object.fromEntries(
				(await db.query('SELECT key,value FROM "Configuration"')).rows.map(row => [row.key, row.value])
			);
			expect(values).toEqual({
				gemini_settings: { analysisModel: 'fixture-gemini', enabled: false },
				openai_settings: { outlineModel: 'fixture-openai', enabled: true },
				backend_settings: fixture.backend_settings
			});
		} finally {
			await db.query('ROLLBACK');
			await db.query('SET search_path TO public');
			await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
			await db.end();
		}
	});
});
