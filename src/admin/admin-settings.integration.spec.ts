import { AdminAnalysisSettingsController, AnalysisSettingsDto } from './admin-analysis-settings.controller.js';
import { AnalysisSettingsService, defaultAnalysisSettings } from '../settings/analysis-settings.service.js';
import { AdminRuntimeSettingsController, SettingsPatchDto } from './admin-runtime-settings.controller.js';
import { ConfigurationSnapshotService } from '../settings/configuration-snapshot.service.js';
import { AppConfigController } from '../settings/app-config.controller.js';
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
import { AiCapacityError } from '../ai/usage/ai-capacity.error.js';
const url = process.env.AUDIO_FLOW_TEST_DATABASE_URL;
if (url && (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname) || !new URL(url).pathname.endsWith('_test')))
	throw new Error('Disposable local test DB required');
describe.skipIf(!url)('Super Admin analysis-model settings', () => {
	const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) });
	const configValues: Record<string, string> = { GEMINI_MODEL: 'gemini-test-env' };
	const config = { get: (key: string, fallback?: string) => configValues[key] ?? fallback };
	const settings = new AppSettingsService(prisma as any, config as any);
	const jwt = new JwtService({ secret: 'settings-test-access' });
	const tokens = new TokenService(jwt, prisma as any);
	const endpoint = '/admin/settings/analysis-model';
	let app: INestApplication;
	let superToken: string, adminToken: string, memberToken: string;
	const users: number[] = [];
	const oldSecret = process.env.JWT_REFRESH_SECRET;
	beforeAll(async () => {
		process.env.JWT_REFRESH_SECRET = 'settings-test-refresh';
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
		Reflect.defineMetadata('design:paramtypes', [AnalysisSettingsService], AdminAnalysisSettingsController);
		Reflect.defineMetadata(
			'design:paramtypes',
			[AnalysisSettingsDto],
			AdminAnalysisSettingsController.prototype,
			'save'
		);
		Reflect.defineMetadata(
			'design:paramtypes',
			[UpdateAnalysisModelDto],
			AdminSettingsController.prototype,
			'setModel'
		);
		Reflect.defineMetadata(
			'design:paramtypes',
			[AppSettingsService, ConfigurationSnapshotService],
			AdminRuntimeSettingsController
		);
		Reflect.defineMetadata(
			'design:paramtypes',
			[String, SettingsPatchDto],
			AdminRuntimeSettingsController.prototype,
			'save'
		);
		Reflect.defineMetadata('design:paramtypes', [AppSettingsService], AppConfigController);

		const module = await Test.createTestingModule({
			controllers: [
				AdminAnalysisSettingsController,
				AdminSettingsController,
				AdminRuntimeSettingsController,
				AppConfigController
			],
			providers: [
				{ provide: AnalysisSettingsService, useValue: new AnalysisSettingsService(prisma as any, settings) },
				{ provide: AppSettingsService, useValue: settings },
				{
					provide: ConfigurationSnapshotService,
					useValue: new ConfigurationSnapshotService(prisma as any, config as any, settings)
				},
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
		await prisma.configuration.deleteMany();
		configValues.GEMINI_MODEL = 'gemini-test-env';
		configValues.GEMINI_API_KEY = 'AIza-fixture-secret-original';
	});
	afterAll(async () => {
		await app?.close();
		await prisma.configuration.deleteMany();
		await prisma.user.deleteMany({ where: { id: { in: users } } });
		await prisma.$disconnect();
		if (oldSecret === undefined) delete process.env.JWT_REFRESH_SECRET;
		else process.env.JWT_REFRESH_SECRET = oldSecret;
	});
	const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
	it('protects and persists analysis routing configuration without exposing it publicly', async () => {
		const route = '/admin/settings/analysis';
		for (const method of ['get', 'patch'] as const) {
			await request(app.getHttpServer())
				[method](route)
				.send(method === 'patch' ? { configuration: defaultAnalysisSettings('fixture') } : undefined)
				.expect(401);
			await request(app.getHttpServer())
				[method](route)
				.set(auth(adminToken))
				.send(method === 'patch' ? { configuration: defaultAnalysisSettings('fixture') } : undefined)
				.expect(403);
			await request(app.getHttpServer())
				[method](route)
				.set(auth(memberToken))
				.send(method === 'patch' ? { configuration: defaultAnalysisSettings('fixture') } : undefined)
				.expect(401);
		}
		const configuration = {
			...defaultAnalysisSettings('gemini-test'),
			providerFallback: true,
			providers: {
				gemini: {
					primaryModel: 'gemini-test',
					models: [
						{ id: 'gemini-test', enabled: true },
						{ id: 'gemini-disabled', enabled: false }
					]
				},
				openai: { primaryModel: 'gpt-test', models: [{ id: 'gpt-test', enabled: true }] }
			}
		};
		const saved = await request(app.getHttpServer())
			.patch(route)
			.set(auth(superToken))
			.send({ configuration })
			.expect(200);
		expect(saved.body).toEqual(configuration);
		expect((await request(app.getHttpServer()).get(route).set(auth(superToken)).expect(200)).body).toEqual(
			configuration
		);
		expect(saved.headers['cache-control']).toBe('private, no-store');
		await request(app.getHttpServer())
			.patch(route)
			.set(auth(superToken))
			.send({ configuration: { ...configuration, retryLimit: 11 } })
			.expect(400);
		await request(app.getHttpServer())
			.patch(route)
			.set(auth(superToken))
			.send({ configuration: { ...configuration, secret: 'not-allowed' } })
			.expect(400);
		await request(app.getHttpServer())
			.patch(route)
			.set(auth(superToken))
			.set('Origin', 'https://untrusted.invalid')
			.send({ configuration })
			.expect(403);
		await request(app.getHttpServer()).patch(endpoint).set(auth(superToken)).send({ model: 'legacy' }).expect(400);
		expect((await request(app.getHttpServer()).get('/app-config').expect(200)).body).not.toHaveProperty(
			'analysis_settings'
		);
	});
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
	it('preserves scanner environment fallback, saves across instances and resets', async () => {
		configValues.AUDIO_RETRY_SCAN_INTERVAL_MS = '45000';
		try {
			expect((await settings.section('processing')).values.retryScanIntervalMs).toBe(45000);
			await request(app.getHttpServer())
				.patch('/admin/config/processing')
				.set(auth(superToken))
				.send({ values: { retryScanIntervalMs: 15000 } })
				.expect(200);
			const withoutEnvironment = new AppSettingsService(prisma as any, { get: () => undefined } as any);
			expect((await withoutEnvironment.section('processing')).values.retryScanIntervalMs).toBe(15000);
			await settings.updateSection('processing', { retryScanIntervalMs: null });
			expect((await settings.section('processing')).values.retryScanIntervalMs).toBe(45000);
			expect((await withoutEnvironment.section('processing')).values.retryScanIntervalMs).toBe(30000);
		} finally {
			delete configValues.AUDIO_RETRY_SCAN_INTERVAL_MS;
		}
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
		expect(await prisma.configuration.count()).toBe(0);
	});
	it('rejects cross-origin writes', async () => {
		await request(app.getHttpServer())
			.patch(endpoint)
			.set(auth(superToken))
			.set('Origin', 'https://untrusted.example')
			.send({ model: 'gemini-test' })
			.expect(403);
		expect(await prisma.configuration.count()).toBe(0);
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
			usage: new AiUsageService(prisma as any, config as any, settings),
			geminiClient: async () => ({ models: { generateContent } })
		});
		await ai.analyzeStory('Hi', users[0]);
		expect(generateContent.mock.calls[0][0].model).toBe('gemini-test-env');
		await settings.setAnalysisModel('gemini-test-saved');
		await ai.analyzeStory('Hi', users[0]);
		expect(generateContent.mock.calls[1][0].model).toBe('gemini-test-saved');
	});
	it('enforces permissions on configuration and removes provider key-management routes', async () => {
		await request(app.getHttpServer()).get('/admin/config/web-settings').expect(401);
		await request(app.getHttpServer()).get('/admin/config/web-settings').set(auth(memberToken)).expect(401);
		await request(app.getHttpServer()).get('/admin/config/web-settings').set(auth(adminToken)).expect(403);
		await request(app.getHttpServer())
			.patch('/admin/config/features')
			.set(auth(adminToken))
			.send({ values: { audioEnabled: false } })
			.expect(403);
		for (const [method, path] of [
			['get', 'gemini'],
			['post', 'gemini'],
			['post', 'gemini/import-environment'],
			['post', 'gemini/use-environment'],
			['patch', 'gemini/old-record'],
			['delete', 'gemini/old-record']
		] as const)
			await request(app.getHttpServer())
				[method]('/admin/provider-keys/' + path)
				.set(auth(superToken))
				.send({})
				.expect(404);
	});
	it('restricts storage controls to Super Admin and persists a boolean without public exposure', async () => {
		const route = '/admin/config/storage';
		for (const method of ['get', 'patch'] as const) {
			await request(app.getHttpServer())
				[method](route)
				.send(method === 'patch' ? { values: { cleanupEnabled: false } } : undefined)
				.expect(401);
			await request(app.getHttpServer())
				[method](route)
				.set(auth(memberToken))
				.send(method === 'patch' ? { values: { cleanupEnabled: false } } : undefined)
				.expect(401);
			await request(app.getHttpServer())
				[method](route)
				.set(auth(adminToken))
				.send(method === 'patch' ? { values: { cleanupEnabled: false } } : undefined)
				.expect(403);
		}
		configValues.STORAGE_CLEANUP_ENABLED = 'false';
		try {
			expect((await settings.section('storage')).values.cleanupEnabled).toBe(false);
			await request(app.getHttpServer())
				.patch(route)
				.set(auth(superToken))
				.set('Origin', 'https://untrusted.invalid')
				.send({ values: { cleanupEnabled: true } })
				.expect(403);
			for (const value of ['false', 0, 1])
				await request(app.getHttpServer())
					.patch(route)
					.set(auth(superToken))
					.send({ values: { cleanupEnabled: value } })
					.expect(400);
			await request(app.getHttpServer())
				.patch(route)
				.set(auth(superToken))
				.send({ values: { cleanupEnabled: true } })
				.expect(200);
			const fresh = new AppSettingsService(prisma as any, { get: () => undefined } as any);
			expect((await fresh.section('storage')).values.cleanupEnabled).toBe(true);
			await request(app.getHttpServer())
				.patch(route)
				.set(auth(superToken))
				.send({ values: { cleanupEnabled: false } })
				.expect(200);
			expect((await fresh.section('storage')).values.cleanupEnabled).toBe(false);
			const read = await request(app.getHttpServer()).get(route).set(auth(superToken)).expect(200);
			expect(read.headers['cache-control']).toBe('private, no-store');
			const exported = await request(app.getHttpServer())
				.get('/admin/config/debug')
				.set(auth(superToken))
				.expect(200);
			expect(exported.body.effectiveConfig.backend_settings.storage.cleanupEnabled).toEqual({
				value: false,
				source: 'database'
			});
			expect(
				JSON.stringify((await request(app.getHttpServer()).get('/app-config').expect(200)).body)
			).not.toContain('cleanupEnabled');
			await settings.updateSection('storage', { cleanupEnabled: null });
			expect((await settings.section('storage')).values.cleanupEnabled).toBe(false);
			expect((await fresh.section('storage')).values.cleanupEnabled).toBe(true);
		} finally {
			delete configValues.STORAGE_CLEANUP_ENABLED;
		}
	});

	it('allows only Super Admin notice edits and publishes an allowlisted advance warning', async () => {
		const route = '/admin/config/maintenance';
		const values = {
			noticeEnabled: true,
			message: '  Please save your work.  ',
			earlyReminderMinutes: 45,
			soonReminderMinutes: 15,
			finalReminderMinutes: 3,
			startsAt: new Date(Date.now() + 3600000).toISOString(),
			endsAt: new Date(Date.now() + 7200000).toISOString()
		};
		for (const method of ['get', 'patch'] as const) {
			for (const [token, status] of [
				[undefined, 401],
				[memberToken, 401],
				[adminToken, 403]
			] as const) {
				const req = request(app.getHttpServer())[method](route);
				if (token) req.set(auth(token));
				await req.send(method === 'patch' ? { values } : undefined).expect(status);
			}
		}
		await request(app.getHttpServer())
			.patch(route)
			.set(auth(superToken))
			.set('Origin', 'https://untrusted.invalid')
			.send({ values })
			.expect(403);
		await request(app.getHttpServer()).patch(route).set(auth(superToken)).send({ values }).expect(200);
		const read = await request(app.getHttpServer()).get(route).set(auth(superToken)).expect(200);
		expect(read.headers['cache-control']).toBe('private, no-store');
		const config = await request(app.getHttpServer()).get('/app-config').expect(200);
		expect(config.headers['cache-control']).toBe('no-store');
		expect(config.body.maintenanceNotice).toEqual({
			enabled: true,
			message: values.message.trim(),
			startsAt: values.startsAt,
			endsAt: values.endsAt,
			reminderMinutes: [45, 15, 3]
		});
		expect(config.body.features.maintenanceMode).toBe(false);
		expect(config.body).not.toHaveProperty('maintenance');
		expect(JSON.stringify(config.body)).not.toContain('noticeEnabled');
		expect((await new AppSettingsService(prisma as any, config as any).section('maintenance')).values.message).toBe(
			values.message.trim()
		);
		const debug = await request(app.getHttpServer()).get('/admin/config/debug').set(auth(superToken)).expect(200);
		expect(debug.body.effectiveConfig.backend_settings.maintenance.noticeEnabled).toEqual({
			value: true,
			source: 'database'
		});
	});
	it('validates notice types, bounded plain text and UTC window atomically, including partial resets', async () => {
		const values = {
			noticeEnabled: true,
			message: '<b>Literal notice</b>',
			earlyReminderMinutes: 30,
			soonReminderMinutes: 10,
			finalReminderMinutes: 2,
			startsAt: new Date(Date.now() + 3600000).toISOString(),
			endsAt: new Date(Date.now() + 7200000).toISOString()
		};
		await settings.updateSection('maintenance', values);
		for (const patch of [
			{ noticeEnabled: 'true' },
			{ earlyReminderMinutes: 0 },
			{ earlyReminderMinutes: 1441 },
			{ soonReminderMinutes: 1.5 },
			{ finalReminderMinutes: '2' },
			{ soonReminderMinutes: 30 },
			{ earlyReminderMinutes: 5 },
			{ finalReminderMinutes: 10 },
			{ message: 'x'.repeat(501) },
			{ message: '   ' },
			{ startsAt: '2026-10-29T10:00' },
			{ startsAt: '2026-02-30T00:00:00.000Z' },
			{ endsAt: values.startsAt },
			{ startsAt: null },
			{ apiKey: 'not-accepted' }
		]) {
			await request(app.getHttpServer())
				.patch('/admin/config/maintenance')
				.set(auth(superToken))
				.send({ values: patch })
				.expect(400);
			expect((await settings.section('maintenance')).values).toEqual(values);
		}
		await settings.updateSection('maintenance', { noticeEnabled: false });
		expect((await settings.appConfig()).maintenanceNotice).toBeNull();
		await settings.updateSection('maintenance', {
			noticeEnabled: null,
			message: null,
			startsAt: null,
			endsAt: null
		});
		expect((await settings.section('maintenance')).values).toEqual({
			noticeEnabled: false,
			message: '',
			startsAt: '',
			endsAt: '',
			earlyReminderMinutes: 30,
			soonReminderMinutes: 10,
			finalReminderMinutes: 2
		});
	});
	it('replaces legacy interval settings with threshold defaults and serializes competing schedule edits', async () => {
		await prisma.configuration.upsert({
			where: { key: 'backend_settings' },
			create: { key: 'backend_settings', value: { maintenance: { reminderIntervalMinutes: 5 } } },
			update: { value: { maintenance: { reminderIntervalMinutes: 5 } } }
		});
		const values = (await settings.section('maintenance')).values;
		expect(values).toMatchObject({ earlyReminderMinutes: 30, soonReminderMinutes: 10, finalReminderMinutes: 2 });
		expect(values).not.toHaveProperty('reminderIntervalMinutes');
		const result = await Promise.allSettled([
			settings.updateSection('maintenance', { earlyReminderMinutes: 11 }),
			settings.updateSection('maintenance', { soonReminderMinutes: 20 })
		]);
		expect(result.filter(item => item.status === 'rejected')).toHaveLength(1);
		const saved = (await settings.section('maintenance')).values;
		expect(Number(saved.earlyReminderMinutes)).toBeGreaterThan(Number(saved.soonReminderMinutes));
		expect(Number(saved.soonReminderMinutes)).toBeGreaterThan(Number(saved.finalReminderMinutes));
		const raw = await prisma.configuration.findUnique({ where: { key: 'backend_settings' } });
		expect((raw!.value as any).maintenance).not.toHaveProperty('reminderIntervalMinutes');
	});
	it('expires announcements without toggling real maintenance and preserves valid concurrent edits', async () => {
		await settings.updateSection('features', { maintenanceMode: true });
		await settings.updateSection('maintenance', {
			noticeEnabled: true,
			message: 'Past window',
			startsAt: new Date(Date.now() - 7200000).toISOString(),
			endsAt: new Date(Date.now() - 3600000).toISOString()
		});
		expect((await settings.appConfig()).maintenanceNotice).toBeNull();
		expect((await settings.section('features')).values.maintenanceMode).toBe(true);
		await settings.updateSection('maintenance', {
			noticeEnabled: false,
			startsAt: new Date(Date.now() + 3600000).toISOString(),
			endsAt: new Date(Date.now() + 7200000).toISOString()
		});
		const result = await Promise.allSettled([
			settings.updateSection('maintenance', { noticeEnabled: true }),
			settings.updateSection('maintenance', { startsAt: null })
		]);
		expect(result.filter(x => x.status === 'rejected')).toHaveLength(1);
		const current = (await settings.section('maintenance')).values;
		expect(
			current.noticeEnabled === false || (typeof current.startsAt === 'string' && current.startsAt.length > 0)
		).toBe(true);
		expect((await settings.section('features')).values.maintenanceMode).toBe(true);
	});
	it('restricts checkout control to Super Admin and preserves private persisted overrides without the env flag', async () => {
		const route = '/admin/config/payments';
		for (const method of ['get', 'patch'] as const) {
			for (const [token, status] of [
				[undefined, 401],
				[memberToken, 401],
				[adminToken, 403]
			] as const) {
				const req = request(app.getHttpServer())[method](route);
				if (token) req.set(auth(token));
				await req.send(method === 'patch' ? { values: { checkoutEnabled: true } } : undefined).expect(status);
			}
		}
		configValues.RAZORPAY_ENABLED = 'true';
		try {
			expect((await settings.section('payments')).values.checkoutEnabled).toBe(true);
			await request(app.getHttpServer())
				.patch(route)
				.set(auth(superToken))
				.set('Origin', 'https://untrusted.invalid')
				.send({ values: { checkoutEnabled: false } })
				.expect(403);
			for (const value of ['true', 0, 1])
				await request(app.getHttpServer())
					.patch(route)
					.set(auth(superToken))
					.send({ values: { checkoutEnabled: value } })
					.expect(400);
			await request(app.getHttpServer())
				.patch(route)
				.set(auth(superToken))
				.send({ values: { apiKey: 'not-accepted' } })
				.expect(400);
			await request(app.getHttpServer())
				.patch(route)
				.set(auth(superToken))
				.send({ values: { checkoutEnabled: false } })
				.expect(200);
			const fresh = new AppSettingsService(prisma as any, { get: () => undefined } as any);
			expect((await fresh.section('payments')).values.checkoutEnabled).toBe(false);
			await request(app.getHttpServer())
				.patch(route)
				.set(auth(superToken))
				.send({ values: { checkoutEnabled: true } })
				.expect(200);
			expect((await fresh.section('payments')).values.checkoutEnabled).toBe(true);
			const read = await request(app.getHttpServer()).get(route).set(auth(superToken)).expect(200);
			expect(read.headers['cache-control']).toBe('private, no-store');
			const debug = await request(app.getHttpServer())
				.get('/admin/config/debug')
				.set(auth(superToken))
				.expect(200);
			expect(debug.body.effectiveConfig.backend_settings.payments.checkoutEnabled).toEqual({
				value: true,
				source: 'database'
			});
			expect(debug.body.paymentStatus.enabled).toBe(true);
			expect(
				JSON.stringify((await request(app.getHttpServer()).get('/app-config').expect(200)).body)
			).not.toContain('checkoutEnabled');
			await settings.updateSection('payments', { checkoutEnabled: null });
			expect((await settings.section('payments')).values.checkoutEnabled).toBe(true);
			expect((await fresh.section('payments')).values.checkoutEnabled).toBe(false);
		} finally {
			delete configValues.RAZORPAY_ENABLED;
		}
	});
	it('restricts login security reads/writes to current Super Admins and trusted origins', async () => {
		const route = '/admin/config/security';
		const payload = { values: { adminLoginAccountLimit: 6 } };
		for (const method of ['get', 'patch'] as const) {
			await request(app.getHttpServer())
				[method](route)
				.send(method === 'patch' ? payload : undefined)
				.expect(401);
			await request(app.getHttpServer())
				[method](route)
				.set(auth(memberToken))
				.send(method === 'patch' ? payload : undefined)
				.expect(401);
			await request(app.getHttpServer())
				[method](route)
				.set(auth(adminToken))
				.send(method === 'patch' ? payload : undefined)
				.expect(403);
		}
		await request(app.getHttpServer())
			.patch(route)
			.set(auth(superToken))
			.set('Origin', 'https://untrusted.invalid')
			.send(payload)
			.expect(403);
		await prisma.user.update({ where: { id: users[0] }, data: { role: 'ADMIN' } });
		try {
			await request(app.getHttpServer()).patch(route).set(auth(superToken)).send(payload).expect(403);
		} finally {
			await prisma.user.update({ where: { id: users[0] }, data: { role: 'SUPERADMIN' } });
		}
		expect(await prisma.configuration.count()).toBe(0);
	});
	it('stores login limits as plain numbers, preserves fallbacks and excludes them from public config', async () => {
		configValues.ADMIN_LOGIN_ACCOUNT_LIMIT = '7';
		try {
			expect((await settings.section('security')).values.adminLoginAccountLimit).toBe(7);
			const values = {
				adminLoginAccountLimit: 5,
				adminLoginIpLimit: 30,
				loginAccountLimit: 10,
				loginIpLimit: 60
			};
			await request(app.getHttpServer())
				.patch('/admin/config/security')
				.set(auth(superToken))
				.send({ values })
				.expect(200);
			const root = (await prisma.configuration.findUniqueOrThrow({ where: { key: 'backend_settings' } }))
				.value as any;
			expect(root.security).toEqual(values);
			const withoutEnv = new AppSettingsService(prisma as any, { get: () => undefined } as any);
			expect((await withoutEnv.section('security')).values).toEqual(values);
			const read = await request(app.getHttpServer())
				.get('/admin/config/security')
				.set(auth(superToken))
				.expect(200);
			expect(read.headers['cache-control']).toBe('private, no-store');
			const debug = await request(app.getHttpServer())
				.get('/admin/config/debug')
				.set(auth(superToken))
				.expect(200);
			expect(debug.body.effectiveConfig.backend_settings.security.adminLoginAccountLimit).toEqual({
				value: 5,
				source: 'database'
			});
			const publicConfig = await request(app.getHttpServer()).get('/app-config').expect(200);
			expect(JSON.stringify(publicConfig.body)).not.toContain('adminLoginAccountLimit');
			await settings.updateSection('security', { adminLoginAccountLimit: null });
			expect((await settings.section('security')).values.adminLoginAccountLimit).toBe(7);
			expect((await withoutEnv.section('security')).values.adminLoginAccountLimit).toBe(5);
		} finally {
			delete configValues.ADMIN_LOGIN_ACCOUNT_LIMIT;
		}
	});
	it('rejects invalid login limits without saving', async () => {
		for (const field of ['adminLoginAccountLimit', 'adminLoginIpLimit', 'loginAccountLimit', 'loginIpLimit'])
			for (const value of [0, -1, 1.5, 1000001, '5', true])
				await request(app.getHttpServer())
					.patch('/admin/config/security')
					.set(auth(superToken))
					.send({ values: { [field]: value } })
					.expect(400);
		await request(app.getHttpServer())
			.patch('/admin/config/security')
			.set(auth(superToken))
			.send({ values: { unsupported: 5 } })
			.expect(400);
		expect(await prisma.configuration.count()).toBe(0);
	});
	it('serves a minimal anonymous startup configuration without private settings or credentials', async () => {
		await settings.updateSection('models', { outlineModel: 'gpt-private-test' });
		const result = await request(app.getHttpServer())
			.get('/app-config')
			.expect(200)
			.expect('Cache-Control', 'no-store');
		expect(Object.keys(result.body).sort()).toEqual([
			'appSettings',
			'appStrings',
			'features',
			'locale',
			'maintenanceNotice'
		]);
		expect(result.body.appSettings).toEqual({});
		expect(result.body.appStrings).toEqual({});
		expect(JSON.stringify(result.body)).not.toContain('gpt-private-test');
		expect(JSON.stringify(result.body)).not.toContain('AIza-fixture');
	});

	it('publishes only maintenance state without fetching public settings or strings', async () => {
		await settings.updateSection('features', { maintenanceMode: true, audioEnabled: false });
		await settings.updateSection('models', { outlineModel: 'private-model' });
		const section = vi.spyOn(settings, 'section');
		try {
			const response = await request(app.getHttpServer())
				.get('/app-config/maintenance')
				.expect(200)
				.expect('Cache-Control', 'no-store');
			expect(response.body).toEqual({ maintenanceMode: true, maintenanceNotice: null });
			expect(section.mock.calls.map(call => call[0]).sort()).toEqual(['features', 'maintenance']);
			expect(JSON.stringify(response.body)).not.toContain('private-model');
			expect(JSON.stringify(response.body)).not.toContain('AIza-fixture');
			await settings.updateSection('features', { maintenanceMode: false });
			expect(
				(await request(app.getHttpServer()).get('/app-config/maintenance').expect(200)).body.maintenanceMode
			).toBe(false);
		} finally {
			section.mockRestore();
		}
	});

	it('shares notice allowlisting with bootstrap and removes disabled or expired notices', async () => {
		await settings.updateSection('maintenance', {
			noticeEnabled: true,
			message: 'Save your work before maintenance.',
			startsAt: new Date(Date.now() + 3600000).toISOString(),
			endsAt: new Date(Date.now() + 7200000).toISOString()
		});
		const response = await request(app.getHttpServer()).get('/app-config/maintenance').expect(200);
		expect(response.body.maintenanceNotice).toEqual((await settings.appConfig()).maintenanceNotice);
		expect(Object.keys(response.body).sort()).toEqual(['maintenanceMode', 'maintenanceNotice']);
		await settings.updateSection('maintenance', { noticeEnabled: false });
		expect((await settings.maintenanceStatus()).maintenanceNotice).toBeNull();
		await settings.updateSection('maintenance', {
			noticeEnabled: true,
			startsAt: new Date(Date.now() - 7200000).toISOString(),
			endsAt: new Date(Date.now() - 3600000).toISOString()
		});
		expect((await settings.maintenanceStatus()).maintenanceNotice).toBeNull();
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
			['processing', { retryScanIntervalMs: 999 }],
			['processing', { retryScanIntervalMs: 1000001 }],
			['processing', { retryScanIntervalMs: 1.5 }],
			['processing', { globalRequestsPerMinute: 0 }],
			['processing', { globalRequestsPerMinute: 1.5 }],
			['processing', { globalRequestsPerMinute: 1000001 }],
			['processing', { userRequestsPerDay: 0 }],
			['processing', { globalCharactersPerDay: 1000000001 }],
			['processing', { userCharactersPerDay: '500' }],
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

	it('persists the global minute cap in admin and enforces live changes across service instances', async () => {
		await prisma.aiUsageBucket.deleteMany();
		await prisma.aiRequestLease.deleteMany();
		const previous = configValues.AI_GLOBAL_REQUESTS_PER_MINUTE;
		configValues.AI_GLOBAL_REQUESTS_PER_MINUTE = '7';
		try {
			expect((await settings.section('processing')).values.globalRequestsPerMinute).toBe(7);
			await request(app.getHttpServer())
				.patch('/admin/config/processing')
				.set(auth(superToken))
				.send({ values: { globalRequestsPerMinute: 1 } })
				.expect(200);
			const usage = new AiUsageService(prisma as any, config as any, settings);
			const withoutEnvironment = {
				get: (key: string) => (key === 'AI_GLOBAL_REQUESTS_PER_MINUTE' ? undefined : config.get(key))
			};
			const otherSettings = new AppSettingsService(prisma as any, withoutEnvironment as any);
			const other = new AiUsageService(prisma as any, withoutEnvironment as any, otherSettings);
			expect((await otherSettings.section('processing')).values.globalRequestsPerMinute).toBe(1);
			const provider = vi.fn(async () => true);
			await usage.execute(users[0], 'tts', 1, provider);
			await expect(other.execute(users[0], 'tts', 1, provider)).rejects.toBeInstanceOf(AiCapacityError);
			expect(provider).toHaveBeenCalledTimes(1);
			await request(app.getHttpServer())
				.patch('/admin/config/processing')
				.set(auth(superToken))
				.send({ values: { globalRequestsPerMinute: 2 } })
				.expect(200);
			await other.execute(users[0], 'tts', 1, provider);
			await expect(usage.execute(users[0], 'tts', 1, provider)).rejects.toBeInstanceOf(AiCapacityError);
			await other.execute(users[0], 'analysis', 1, provider);
			expect(provider).toHaveBeenCalledTimes(3);
			expect(await prisma.aiRequestLease.count()).toBe(0);
		} finally {
			if (previous === undefined) delete configValues.AI_GLOBAL_REQUESTS_PER_MINUTE;
			else configValues.AI_GLOBAL_REQUESTS_PER_MINUTE = previous;
			await prisma.aiUsageBucket.deleteMany();
			await prisma.aiRequestLease.deleteMany();
		}
	});

	it('enforces saved global and per-user character budgets without leaking leases', async () => {
		await prisma.aiUsageBucket.deleteMany();
		await prisma.aiRequestLease.deleteMany();
		try {
			await settings.updateSection('processing', {
				globalRequestsPerMinute: 50,
				globalRequestsPerDay: 50,
				userRequestsPerMinute: 50,
				userRequestsPerDay: 50,
				globalCharactersPerDay: 10,
				userCharactersPerDay: 6
			});
			const usage = new AiUsageService(prisma as any, config as any, settings);
			const provider = vi.fn(async () => true);
			await usage.execute(users[0], 'tts', 6, provider);
			await expect(usage.execute(users[0], 'tts', 1, provider)).rejects.toBeInstanceOf(AiCapacityError);
			await usage.execute(users[1], 'tts', 4, provider);
			await expect(usage.execute(users[2], 'tts', 1, provider)).rejects.toBeInstanceOf(AiCapacityError);
			expect(provider).toHaveBeenCalledTimes(2);
			expect(await prisma.aiRequestLease.count()).toBe(0);
		} finally {
			await prisma.aiUsageBucket.deleteMany();
			await prisma.aiRequestLease.deleteMany();
		}
	});

	it.each(['globalRequestsPerDay', 'userRequestsPerMinute', 'userRequestsPerDay'])(
		'enforces the saved %s budget',
		async field => {
			await prisma.aiUsageBucket.deleteMany();
			await prisma.aiRequestLease.deleteMany();
			try {
				await settings.updateSection('processing', {
					globalRequestsPerMinute: 50,
					globalRequestsPerDay: 50,
					userRequestsPerMinute: 50,
					userRequestsPerDay: 50,
					globalCharactersPerDay: 100,
					userCharactersPerDay: 100,
					[field]: 1
				});
				const usage = new AiUsageService(prisma as any, config as any, settings);
				const provider = vi.fn(async () => true);
				await usage.execute(users[0], 'tts', 1, provider);
				await expect(
					usage.execute(field === 'globalRequestsPerDay' ? users[1] : users[0], 'tts', 1, provider)
				).rejects.toBeInstanceOf(AiCapacityError);
				expect(provider).toHaveBeenCalledTimes(1);
			} finally {
				await prisma.aiUsageBucket.deleteMany();
				await prisma.aiRequestLease.deleteMany();
			}
		}
	);

	it('preserves sibling backend groups and both language documents during concurrent writes', async () => {
		await Promise.all([
			settings.updateSection('features', { audioEnabled: false }),
			settings.updateSection('processing', { maxRecoveryAttempts: 5 }),
			settings.replaceWebDocument('web-strings', { title: 'English' }, 'en'),
			settings.replaceWebDocument('web-strings', { title: 'हिन्दी' }, 'hi')
		]);
		expect((await settings.section('features')).values.audioEnabled).toBe(false);
		expect((await settings.section('processing')).values.maxRecoveryAttempts).toBe(5);
		expect((await settings.section('web-strings', 'en')).values.title).toBe('English');
		expect((await settings.section('web-strings', 'hi')).values.title).toBe('हिन्दी');
		expect(await prisma.configuration.count()).toBe(2);
	});
	it('exports grouped overrides and debug sources only to Super Admin without credentials', async () => {
		await settings.replaceWebDocument('web-settings', { showStats: false, nested: { apiKey: 'do-not-export' } });
		await settings.updateSection('processing', { maxRecoveryAttempts: 4 });
		await prisma.configuration.create({ data: { key: 'future_service_settings', value: { enabled: true } } });
		for (const route of ['export', 'debug']) {
			await request(app.getHttpServer())
				.get('/admin/config/' + route)
				.expect(401);
			await request(app.getHttpServer())
				.get('/admin/config/' + route)
				.set(auth(adminToken))
				.expect(403);
		}
		const exported = await request(app.getHttpServer())
			.get('/admin/config/export')
			.set(auth(superToken))
			.expect(200);
		expect(exported.headers['cache-control']).toBe('private, no-store');
		expect(exported.body.allConfig.app_settings.showStats).toBe(false);
		expect(exported.body.allConfig.future_service_settings.enabled).toBe(true);
		expect(exported.body.allConfig.app_settings.nested.apiKey).toBe('[REDACTED]');
		expect(JSON.stringify(exported.body)).not.toContain('AIza-fixture-secret-original');
		expect(exported.body.providerStatus.gemini).toEqual({ source: 'environment', configured: true });
		expect(JSON.stringify(exported.body)).not.toContain('do-not-export');
		const debug = await request(app.getHttpServer()).get('/admin/config/debug').set(auth(superToken)).expect(200);
		expect(debug.body.effectiveConfig.backend_settings.processing.maxRecoveryAttempts).toEqual({
			value: 4,
			source: 'database'
		});
		expect(debug.body.effectiveConfig.gemini_settings.analysisModel.source).toBe('environment');
		expect((await settings.appConfig()).appSettings.showStats).toBe(false);
		expect(await settings.appConfig()).not.toHaveProperty('providerStatus');
	});
	it('publishes arbitrary web keys while keeping private backend sections separate', async () => {
		await prisma.configuration.create({
			data: {
				key: 'app_settings',
				value: { showStats: false, customLabel: 'custom-public' }
			}
		});
		await prisma.configuration.create({
			data: {
				key: 'app_strings',
				value: { en: { heroTitle: 'Visible', customLabel: 'custom-public' } }
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
		for (const key of ['audioEnabled', 'analysisEnabled', 'scriptEnabled'] as const)
			await expect(settings.assertEnabled(key)).rejects.toThrow('temporarily disabled');
		for (const key of ['geminiEnabled', 'openaiEnabled'] as const)
			await expect(settings.assertEnabled(key)).resolves.toBeUndefined();
		await settings.updateSection('features', { geminiEnabled: false });
		await expect(settings.assertEnabled('geminiEnabled')).rejects.toThrow('temporarily disabled');
	});
});
