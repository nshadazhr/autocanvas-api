import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

// Never initialize the full application against an operator's DATABASE_URL.
const databaseUrl = process.env.AUDIO_FLOW_TEST_DATABASE_URL;
if (databaseUrl) {
	const url = new URL(databaseUrl);
	if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.endsWith('_test'))
		throw new Error('E2E requires an explicit disposable local *_test database');
}

describe.skipIf(!databaseUrl)('Application HTTP boundaries', () => {
	let app: INestApplication;
	beforeAll(async () => {
		vi.stubEnv('DATABASE_URL', databaseUrl!);
		vi.stubEnv('NODE_ENV', 'test');
		vi.stubEnv('STORAGE_PROVIDER', 'local');
		vi.stubEnv('GEMINI_API_KEY', 'fixture');
		vi.stubEnv('OPENAI_API_KEY', 'fixture');
		vi.stubEnv('RESEND_API_KEY', 're_fixture');
		vi.stubEnv('JWT_SECRET', 'fixture-verification-secret');
		vi.stubEnv('JWT_REFRESH_SECRET', 'fixture-refresh-secret');
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('External provider requests are disabled in E2E')));
		const { AppModule } = await import('../src/app.module.js');
		const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
		app = module.createNestApplication();
		await app.init();
	});
	afterAll(async () => {
		await app?.close();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});
	it('serves the public bootstrap and allowlisted maintenance response without secrets', async () => {
		const bootstrap = await request(app.getHttpServer()).get('/app-config').expect(200);
		expect(Object.keys(bootstrap.body).sort()).toEqual([
			'appSettings',
			'appStrings',
			'features',
			'locale',
			'maintenanceNotice'
		]);
		expect(typeof bootstrap.body.features.maintenanceMode).toBe('boolean');
		const maintenance = await request(app.getHttpServer()).get('/app-config/maintenance').expect(200);
		expect(Object.keys(maintenance.body).sort()).toEqual(['maintenanceMode', 'maintenanceNotice']);
		expect(maintenance.headers['cache-control']).toContain('no-store');
		expect(JSON.stringify(bootstrap.body)).not.toContain('fixture-verification-secret');
	});
	it('rejects unauthenticated access to the user profile', async () => {
		await request(app.getHttpServer()).get('/auth/profile').expect(401);
	});
});
