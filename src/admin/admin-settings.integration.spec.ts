import { AdminRuntimeSettingsController, SettingsPatchDto } from './admin-runtime-settings.controller.js';
import {
	AdminProviderKeysController,
	AddProviderKeyDto,
	ChangeProviderKeyDto
} from './admin-provider-keys.controller.js';
import { AppConfigController } from '../settings/app-config.controller.js';
import { ProviderCredentialsService } from '../settings/provider-credentials.service.js';
import 'reflect-metadata';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AdminSettingsController } from './admin-settings.controller.js';
import { UpdateAnalysisModelDto } from './dto/analysis-model.dto.js';
import { AppSettingsService } from '../settings/app-settings.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TokenService } from '../auth/services/token.service.js';
import { AdminAuthGuard } from '../auth/auth.guard.js';
import { SuperAdminGuard } from '../auth/services/superadmin.guard.js';
import { AuthOriginGuard } from '../auth/services/auth-origin.guard.js';
import { AiService } from '../ai/ai.service.js';
import { AiUsageService } from '../ai/usage/ai-usage.service.js';
const url = process.env.AUDIO_FLOW_TEST_DATABASE_URL;
if (url && (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname) || !new URL(url).pathname.endsWith('_test')))
	throw new Error('Disposable local test DB required');
describe.skipIf(!url)('Super Admin analysis-model settings', () => {
	const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) });
	const configValues: Record<string, string> = { GEMINI_MODEL: 'gemini-test-env' };
	const config = { get: (key: string, fallback?: string) => configValues[key] ?? fallback };
	const settings = new AppSettingsService(prisma as any, config as any);
	const credentials = new ProviderCredentialsService(prisma as any, config as any);
	const jwt = new JwtService({ secret: 'settings-test-access' });
	const tokens = new TokenService(jwt, prisma as any);
	const endpoint = '/admin/settings/analysis-model';
	let app: INestApplication;
	let superToken: string, adminToken: string, memberToken: string;
	const users: number[] = [];
	const oldSecret = process.env.JWT_REFRESH_SECRET;
	beforeAll(async () => {
		process.env.JWT_REFRESH_SECRET = 'settings-test-refresh';
		configValues.AI_KEYS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
		configValues.GEMINI_API_KEY = 'AIza-fixture-secret-original';
		await prisma.$connect();
		for (const role of ['SUPERADMIN', 'ADMIN', 'USER'] as const) {
			const account = await prisma.user.create({
				data: { email: `settings-${randomUUID()}@example.test`, role, email_verified_at: new Date() }
			});
			users.push(account.id);
			const result = await tokens.generateTokens(account, role === 'USER' ? 'user' : 'admin');
			if (role === 'SUPERADMIN') superToken = result.access_token;
			else if (role === 'ADMIN') adminToken = result.access_token;
			else memberToken = result.access_token;
		}
		Reflect.defineMetadata('design:paramtypes', [AppSettingsService], AdminSettingsController);
		Reflect.defineMetadata(
			'design:paramtypes',
			[UpdateAnalysisModelDto],
			AdminSettingsController.prototype,
			'setModel'
		);
		Reflect.defineMetadata('design:paramtypes', [AppSettingsService], AdminRuntimeSettingsController);
		Reflect.defineMetadata(
			'design:paramtypes',
			[String, SettingsPatchDto],
			AdminRuntimeSettingsController.prototype,
			'save'
		);
		Reflect.defineMetadata('design:paramtypes', [ProviderCredentialsService], AdminProviderKeysController);
		Reflect.defineMetadata(
			'design:paramtypes',
			[String, AddProviderKeyDto],
			AdminProviderKeysController.prototype,
			'add'
		);
		Reflect.defineMetadata(
			'design:paramtypes',
			[String, String, ChangeProviderKeyDto],
			AdminProviderKeysController.prototype,
			'change'
		);
		Reflect.defineMetadata('design:paramtypes', [AppSettingsService], AppConfigController);

		const module = await Test.createTestingModule({
			controllers: [
				AdminSettingsController,
				AdminRuntimeSettingsController,
				AdminProviderKeysController,
				AppConfigController
			],
			providers: [
				{ provide: AppSettingsService, useValue: settings },
				{ provide: ProviderCredentialsService, useValue: credentials },
				{ provide: PrismaService, useValue: prisma },
				{ provide: TokenService, useValue: tokens },
				{ provide: AdminAuthGuard, useValue: new AdminAuthGuard(tokens) },
				{ provide: SuperAdminGuard, useValue: new SuperAdminGuard(prisma as any) },
				AuthOriginGuard
			]
		}).compile();
		app = module.createNestApplication();
		app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
		await app.init();
	});
	beforeEach(async () => {
		await prisma.providerCredential.deleteMany();
		await prisma.appSetting.deleteMany();
		configValues.GEMINI_MODEL = 'gemini-test-env';
		configValues.GEMINI_API_KEY = 'AIza-fixture-secret-original';
		configValues.AI_KEYS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
	});
	afterAll(async () => {
		await app?.close();
		await prisma.providerCredential.deleteMany();
		await prisma.appSetting.deleteMany();
		await prisma.user.deleteMany({ where: { id: { in: users } } });
		await prisma.$disconnect();
		if (oldSecret === undefined) delete process.env.JWT_REFRESH_SECRET;
		else process.env.JWT_REFRESH_SECRET = oldSecret;
	});
	const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
	it('rejects anonymous/user tokens and ordinary admins for reads and writes', async () => {
		for (const method of ['get', 'patch'] as const) {
			await request(app.getHttpServer())
				[method](endpoint)
				.send(method === 'patch' ? { model: 'gemini-test' } : undefined)
				.expect(401);
			await request(app.getHttpServer())
				[method](endpoint)
				.set(auth(memberToken))
				.send(method === 'patch' ? { model: 'gemini-test' } : undefined)
				.expect(401);
			await request(app.getHttpServer())
				[method](endpoint)
				.set(auth(adminToken))
				.send(method === 'patch' ? { model: 'gemini-test' } : undefined)
				.expect(403);
		}
	});
	it('uses env/default fallback until an override is saved', async () => {
		const result = await request(app.getHttpServer()).get(endpoint).set(auth(superToken)).expect(200);
		expect(result.headers['cache-control']).toBe('private, no-store');
		expect(result.body).toEqual({ model: 'gemini-test-env', source: 'environment' });
		delete configValues.GEMINI_MODEL;
		expect(await settings.analysisModel()).toEqual({ model: 'gemini-3.5-flash', source: 'default' });
	});
	it('persists changes across service instances and resets to env', async () => {
		const result = await request(app.getHttpServer())
			.patch(endpoint)
			.set(auth(superToken))
			.send({ model: 'gemini-test-saved' })
			.expect(200);
		expect(result.body).toEqual({ model: 'gemini-test-saved', source: 'database' });
		expect(await new AppSettingsService(prisma as any, config as any).analysisModel()).toEqual(result.body);
		const reset = await request(app.getHttpServer())
			.patch(endpoint)
			.set(auth(superToken))
			.send({ model: null })
			.expect(200);
		expect(reset.body).toEqual({ model: 'gemini-test-env', source: 'environment' });
	});
	it('rejects invalid/unknown DTO fields without saving', async () => {
		for (const payload of [
			{},
			{ model: '' },
			{ model: 123 },
			{ model: 'wrong/model' },
			{ model: 'x'.repeat(121) },
			{ model: 'gemini-test', apiKey: 'not-accepted' }
		])
			await request(app.getHttpServer()).patch(endpoint).set(auth(superToken)).send(payload).expect(400);
		expect(await prisma.appSetting.count()).toBe(0);
	});
	it('rejects cross-origin writes', async () => {
		await request(app.getHttpServer())
			.patch(endpoint)
			.set(auth(superToken))
			.set('Origin', 'https://untrusted.example')
			.send({ model: 'gemini-test' })
			.expect(403);
		expect(await prisma.appSetting.count()).toBe(0);
	});
	it('checks the current DB role after token issuance', async () => {
		await prisma.user.update({ where: { id: users[0] }, data: { role: 'ADMIN' } });
		try {
			await request(app.getHttpServer())
				.patch(endpoint)
				.set(auth(superToken))
				.send({ model: 'gemini-test' })
				.expect(403);
		} finally {
			await prisma.user.update({ where: { id: users[0] }, data: { role: 'SUPERADMIN' } });
		}
	});
	it('passes newly saved models to the actual analysis adapter without calling Google', async () => {
		const result = {
			characters: [{ name: 'Narrator', gender: 'Male' }],
			scenes: [
				{
					sceneOrder: 1,
					speakerName: 'Narrator',
					text: 'Hi',
					language: 'en-US',
					emotion: 'Calm',
					style: 'Narrative'
				}
			]
		};
		const generateContent = vi.fn().mockResolvedValue({ text: JSON.stringify(result) });
		const ai = Object.assign(Object.create(AiService.prototype), {
			settings,
			configService: config,
			aiPromptService: { getPrompt: async () => 'fixture' },
			usage: new AiUsageService(prisma as any, config as any),
			geminiClient: async () => ({ models: { generateContent } })
		});
		await ai.analyzeStory('Hi', users[0]);
		expect(generateContent.mock.calls[0][0].model).toBe('gemini-test-env');
		await settings.setAnalysisModel('gemini-test-saved');
		await ai.analyzeStory('Hi', users[0]);
		expect(generateContent.mock.calls[1][0].model).toBe('gemini-test-saved');
	});
	it('enforces permissions and origin checks on configuration and credentials', async () => {
		for (const endpoint of ['/admin/config/web-settings', '/admin/provider-keys/gemini']) {
			await request(app.getHttpServer()).get(endpoint).expect(401);
			await request(app.getHttpServer()).get(endpoint).set(auth(memberToken)).expect(401);
			await request(app.getHttpServer()).get(endpoint).set(auth(adminToken)).expect(403);
		}
		await request(app.getHttpServer())
			.patch('/admin/config/features')
			.set(auth(adminToken))
			.send({ values: { audioEnabled: false } })
			.expect(403);
		await request(app.getHttpServer())
			.post('/admin/provider-keys/gemini')
			.set(auth(adminToken))
			.send({ name: 'No', key: 'secret-not-allowed' })
			.expect(403);
		await request(app.getHttpServer())
			.post('/admin/provider-keys/gemini')
			.set(auth(superToken))
			.set('Origin', 'https://bad.example')
			.send({ name: 'No', key: 'secret-not-allowed' })
			.expect(403);
	});
	it('serves a minimal anonymous startup configuration without private settings or credentials', async () => {
		await settings.updateSection('models', { outlineModel: 'gpt-private-test' });
		const result = await request(app.getHttpServer())
			.get('/app-config')
			.expect(200)
			.expect('Cache-Control', 'no-store');
		expect(Object.keys(result.body).sort()).toEqual(['appSettings', 'appStrings', 'features', 'locale']);
		expect(result.body.appSettings).toEqual({});
		expect(result.body.appStrings).toEqual({});
		expect(JSON.stringify(result.body)).not.toContain('gpt-private-test');
		expect(JSON.stringify(result.body)).not.toContain('AIza-fixture');
	});

	it('publishes web text/settings with locale fallback and never exposes backend settings', async () => {
		await request(app.getHttpServer())
			.patch('/admin/config/web-settings')
			.set(auth(superToken))
			.send({ values: { showStats: false, defaultLanguage: 'hi' } })
			.expect(200);
		await request(app.getHttpServer())
			.patch('/admin/config/web-strings')
			.set(auth(superToken))
			.send({ locale: 'hi', values: { heroTitle: 'नई कहानी' } })
			.expect(200);
		await settings.updateSection('pricing', { analysisCredits: 9 });
		await settings.updateSection('models', { outlineModel: 'gpt-test' });
		const result = await request(app.getHttpServer()).get('/app-config').expect(200);
		expect(result.body).toMatchObject({
			locale: 'hi',
			appSettings: { showStats: false },
			appStrings: { heroTitle: 'नई कहानी' }
		});
		expect(result.body).not.toHaveProperty('models');
		expect(result.body).not.toHaveProperty('pricing');
		expect(JSON.stringify(result.body)).not.toContain('AIza-fixture');
		await settings.updateSection('web-strings', { heroTitle: null }, 'hi');
		expect((await settings.appConfig('hi')).appStrings).not.toHaveProperty('heroTitle');
	});
	it('rejects unknown sections, fields and invalid values', async () => {
		for (const [section, values] of [
			['not-a-section', {}],
			['features', { audioEnabled: 'false' }],
			['pricing', { analysisCredits: -1 }],
			['processing', { maxRecoveryAttempts: 99 }],
			['processing', { recoveryRetryDelayMs: 1 }],
			['web-settings', { defaultLanguage: 'xx' }],
			['web-strings', { arbitraryKey: 5 }]
		])
			await request(app.getHttpServer())
				.patch('/admin/config/' + section)
				.set(auth(superToken))
				.send({ values })
				.expect(400);
		await request(app.getHttpServer())
			.patch('/admin/config/features')
			.set(auth(superToken))
			.send({ values: { audioEnabled: true }, apiKey: 'not-allowed' })
			.expect(400);
		await request(app.getHttpServer()).get('/app-config?locale=xx').expect(400);
	});
	it('publishes arbitrary web keys while keeping private backend sections separate', async () => {
		await prisma.appSetting.create({
			data: {
				key: 'runtime.web-settings',
				value: JSON.stringify({ showStats: false, customLabel: 'custom-public' })
			}
		});
		await prisma.appSetting.create({
			data: {
				key: 'web.strings.en',
				value: JSON.stringify({ heroTitle: 'Visible', customLabel: 'custom-public' })
			}
		});
		const result = await settings.appConfig('en');
		expect(result.appSettings.showStats).toBe(false);
		expect(result.appStrings.heroTitle).toBe('Visible');
		expect(result.appSettings).toHaveProperty('customLabel', 'custom-public');
		expect(result.appStrings).toHaveProperty('customLabel', 'custom-public');
		expect(result).not.toHaveProperty('models');
	});
	it('merges concurrent partial settings without losing updates and resets values', async () => {
		await Promise.all([
			settings.updateSection('web-settings', { showStats: false }),
			settings.updateSection('web-settings', { showChannels: false })
		]);
		expect((await settings.section('web-settings')).values).toMatchObject({
			showStats: false,
			showChannels: false
		});
		await settings.updateSection('web-settings', { showStats: null });
		expect((await settings.section('web-settings')).values).not.toHaveProperty('showStats');
	});
	it('replaces JSON documents, preserves data types and removes omitted overrides', async () => {
		const values = {
			SIMULATE_PERIMETERX_BLOCKING: true,
			TARGET_ENDPOINT: '/api/mobile/customers/login',
			nested: { options: [1, false, null, { title: 'हिंदी' }] },
			zero: 0,
			empty: ''
		};
		await request(app.getHttpServer())
			.put('/admin/config/web-settings')
			.set(auth(superToken))
			.send({ values })
			.expect(200);
		expect((await settings.appConfig()).appSettings).toEqual(values);
		await request(app.getHttpServer())
			.put('/admin/config/web-strings')
			.set(auth(superToken))
			.send({ values: { congrats: 'Congrats!', html: '<b>STOP</b> {0} {{{url}}}', empty: '' } })
			.expect(200);
		expect((await settings.appConfig()).appStrings).toEqual({
			congrats: 'Congrats!',
			html: '<b>STOP</b> {0} {{{url}}}',
			empty: ''
		});
		await request(app.getHttpServer())
			.put('/admin/config/web-settings')
			.set(auth(superToken))
			.send({ values: {} })
			.expect(200);
		expect((await settings.appConfig()).appSettings).toEqual({});
		expect((await settings.appConfig()).locale).toBe('en');
	});
	it('protects JSON replacement with existing role/origin guards and rejects invalid documents', async () => {
		await request(app.getHttpServer())
			.put('/admin/config/web-settings')
			.set(auth(adminToken))
			.send({ values: {} })
			.expect(403);
		await request(app.getHttpServer())
			.put('/admin/config/web-settings')
			.set(auth(superToken))
			.set('Origin', 'https://bad.example')
			.send({ values: {} })
			.expect(403);
		await expect(
			settings.replaceWebDocument('web-settings', JSON.parse('{"nested":{"__proto__":true}}'))
		).rejects.toThrow('Unsupported JSON key');
		// Nest class-transformer strips unsafe object keys before the controller receives them.
		const sanitized = await request(app.getHttpServer())
			.put('/admin/config/web-settings')
			.set(auth(superToken))
			.send({ values: JSON.parse('{"nested":{"prototype":true}}') })
			.expect(200);
		expect(sanitized.body.values).toEqual({ nested: {} });
		for (const [section, values] of [
			['web-strings', { list: ['text'] }],
			['web-settings', []],
			['models', {}]
		])
			await request(app.getHttpServer())
				.put('/admin/config/' + section)
				.set(auth(superToken))
				.send({ values })
				.expect(response => {
					expect(
						response.status,
						section + ': ' + JSON.stringify(values) + ' => ' + JSON.stringify(response.body)
					).toBe(400);
				});
	});

	it('persists pricing configuration without immediately changing user balances', async () => {
		const before = await prisma.user.findMany({ where: { id: { in: users } }, orderBy: { id: 'asc' } });
		await settings.updateSection('pricing', { analysisCredits: 5, audioCreditsPer1000Characters: 2 });
		expect((await settings.section('pricing')).values).toEqual({
			analysisCredits: 5,
			audioCreditsPer1000Characters: 2,
			welcomeCredits: 0
		});
		expect(await prisma.user.findMany({ where: { id: { in: users } }, orderBy: { id: 'asc' } })).toEqual(before);
	});
	it('encrypts imported credentials, masks responses and keeps disabled keys from falling back', async () => {
		expect((await credentials.available('gemini'))[0].key).toBe('AIza-fixture-secret-original');
		const imported = await request(app.getHttpServer())
			.post('/admin/provider-keys/gemini/import-environment')
			.set(auth(superToken))
			.send({})
			.expect(201);
		expect(imported.body.managed).toBe(true);
		expect(imported.body.keys).toHaveLength(1);
		expect(JSON.stringify(imported.body)).not.toContain('AIza-fixture-secret-original');
		const row = await prisma.providerCredential.findFirstOrThrow();
		expect(row.encrypted).not.toContain('AIza-fixture-secret-original');
		configValues.GEMINI_API_KEY = 'AIza-fixture-different-env';
		expect(await credentials.primary('gemini')).toBe('AIza-fixture-secret-original');
		await credentials.change('gemini', row.id, false);
		expect(await credentials.available('gemini')).toEqual([]);
		await expect(credentials.primary('gemini')).rejects.toThrow('No enabled');
		await credentials.useEnvironment('gemini');
		expect(await credentials.primary('gemini')).toBe('AIza-fixture-different-env');
	});
	it('adds, disables, enables and removes keys without returning full secrets', async () => {
		const added = await request(app.getHttpServer())
			.post('/admin/provider-keys/openai')
			.set(auth(superToken))
			.send({ name: 'Primary', key: 'sk-fixture-secret-one' })
			.expect(201);
		const id = added.body.keys[0].id;
		expect(added.body.keys[0].maskedKey).toBe('••••-one');
		expect(JSON.stringify(added.body)).not.toContain('sk-fixture-secret-one');
		expect(await credentials.primary('openai')).toBe('sk-fixture-secret-one');
		await request(app.getHttpServer())
			.patch('/admin/provider-keys/openai/' + id)
			.set(auth(superToken))
			.send({ enabled: false })
			.expect(200);
		expect(await credentials.available('openai')).toEqual([]);
		await credentials.change('openai', id, true);
		expect(await credentials.primary('openai')).toBe('sk-fixture-secret-one');
		await request(app.getHttpServer())
			.delete('/admin/provider-keys/openai/' + id)
			.set(auth(superToken))
			.expect(200);
		expect(await credentials.available('openai')).toEqual([]);
		await request(app.getHttpServer())
			.post('/admin/provider-keys/unknown')
			.set(auth(superToken))
			.send({ name: 'No', key: 'test-secret' })
			.expect(400);
	});
	it('replaces the single key and detects tampering/wrong master keys without leaking secrets', async () => {
		const saved = await credentials.add('gemini', 'One', 'AIza-fixture-secret-original');
		const replaced = await credentials.add('gemini', 'Replacement', 'AIza-fixture-secret-original');
		expect(replaced.keys[0].id).toBe(saved.keys[0].id);
		expect(await prisma.providerCredential.count({ where: { provider: 'gemini' } })).toBe(1);
		configValues.AI_KEYS_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64');
		await expect(credentials.available('gemini')).rejects.toThrow('could not be decrypted');
		configValues.AI_KEYS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
		const row = await prisma.providerCredential.findUniqueOrThrow({ where: { id: saved.keys[0].id } });
		await prisma.providerCredential.update({
			where: { id: row.id },
			data: { encrypted: row.encrypted.slice(0, -4) + 'AAAA' }
		});
		await expect(credentials.available('gemini')).rejects.toThrow('could not be decrypted');
	});
	it('ignores multi-key environment flags and never falls through to legacy extra keys', async () => {
		configValues.GEMINI_MULTI_KEY_ENABLED = 'true';
		configValues.GEMINI_API_KEYS = 'AIza-unused-backup-one,AIza-unused-backup-two';
		expect(await credentials.available('gemini')).toEqual([
			{ id: 'environment', key: 'AIza-fixture-secret-original' }
		]);
		const selected = await credentials.importEnvironment('gemini');
		const id = selected.keys[0].id;
		const legacy = await prisma.providerCredential.create({
			data: {
				id: randomUUID(),
				provider: 'gemini',
				name: 'Legacy ignored backup',
				encrypted: 'legacy-ciphertext-preserved',
				fingerprint: randomUUID(),
				suffix: 'old1',
				createdAt: new Date(Date.now() + 10000)
			}
		});
		await credentials.change('gemini', id, false);
		expect(await credentials.available('gemini')).toEqual([]);
		await expect(credentials.primary('gemini')).rejects.toThrow('No enabled');
		await credentials.add('gemini', 'Replacement', 'AIza-new-single-key');
		expect((await credentials.list('gemini')).keys).toHaveLength(1);
		expect(await credentials.primary('gemini')).toBe('AIza-new-single-key');
		expect(await prisma.providerCredential.count({ where: { provider: 'gemini' } })).toBe(2);
		expect((await prisma.providerCredential.findUniqueOrThrow({ where: { id: legacy.id } })).encrypted).toBe(
			'legacy-ciphertext-preserved'
		);
		await credentials.remove('gemini', id);
		expect(await credentials.available('gemini')).toEqual([]);
		expect((await credentials.list('gemini')).keys).toEqual([]);
	});

	it('enforces feature/provider switches and allows cancellation/download routes to remain independent', async () => {
		await settings.updateSection('features', {
			audioEnabled: false,
			analysisEnabled: false,
			scriptEnabled: false
		});
		for (const key of ['audioEnabled', 'analysisEnabled', 'scriptEnabled'] as const)
			await expect(settings.assertEnabled(key)).rejects.toThrow('temporarily disabled');
		await settings.updateSection('features', { analysisEnabled: true });
		await expect(settings.assertEnabled('analysisEnabled')).resolves.toBeUndefined();
		await settings.updateSection('features', { maintenanceMode: true });
		await expect(settings.assertEnabled('analysisEnabled')).rejects.toThrow('temporarily disabled');
	});
});
