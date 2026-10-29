import { AppSettingsService } from '../settings/app-settings.service.js';
import { AdminAnalysisJobsService } from '../admin/admin-analysis-jobs.service.js';
import { defaultAnalysisSettings } from '../settings/analysis-settings.service.js';
import { AnalysisRun } from '../ai/analysis/analysis-runner.service.js';
import { CreditsService } from '../credits/credits.service.js';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AudioStoriesController } from './audio-stories.controller.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { AiService } from '../ai/ai.service.js';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { AudioStoriesService } from './audio-stories.service.js';
import { StoryParserService } from './services/story-parser.service.js';
import { StoryAnalysisValidatorService } from './services/story-analysis-validator.service.js';
import { AiUsageService } from '../ai/usage/ai-usage.service.js';
import { AiCapacityError } from '../ai/usage/ai-capacity.error.js';
import { safeAiError } from '../ai/usage/safe-ai-error.js';
const databaseUrl = process.env.AUDIO_FLOW_TEST_DATABASE_URL;
if (databaseUrl) {
	const url = new URL(databaseUrl);
	if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.endsWith('_test'))
		throw new Error('Disposable local test DB required');
}
describe.skipIf(!databaseUrl)('analysis retries and shared AI budgets', () => {
	const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl! }) });
	const limits: Record<string, string> = {};
	const config = { get: (key: string) => limits[key] };
	const usage = new AiUsageService(
		prisma as any,
		config as any,
		new AppSettingsService(prisma as any, config as any)
	);
	const provider = {
		analyze: vi.fn(),
		assertEnabled: vi.fn().mockResolvedValue(undefined),
		getModel: vi.fn().mockResolvedValue('gemini-3.5-flash'),
		getConfiguration: vi.fn(async () => ({
			...defaultAnalysisSettings(await provider.getModel()),
			retryDelaySeconds: 1,
			retryLimit: 6
		}))
	};
	let dispatchProviderRequest = true;
	const service = new AudioStoriesService(
		prisma as any,
		{
			...provider,
			analyze: async (
				content: string,
				user: number,
				model: string,
				which: string,
				onRequest?: () => Promise<void>
			) => {
				if (dispatchProviderRequest) await onRequest?.();
				return provider.analyze(content, user, model, which);
			}
		} as any,
		new StoryParserService(),
		new StoryAnalysisValidatorService(),
		config as any,
		usage,
		new CreditsService(prisma as any)
	);
	const result = {
		characters: [{ name: 'Narrator', gender: 'Male' }],
		scenes: [
			{
				sceneOrder: 1,
				speakerName: 'Narrator',
				text: 'Hello world',
				language: 'en-US',
				emotion: 'Calm',
				style: 'Narration'
			}
		]
	};
	let app: INestApplication;
	const jwt = new JwtService({ secret: 'analysis-integration-only' });
	let userId: number;
	let storyId: number;
	const job = (id: string) => prisma.storyAnalysisJob.findUniqueOrThrow({ where: { id } });
	beforeAll(async () => {
		await prisma.$connect();
		userId = (await prisma.user.create({ data: { email: `analysis-${randomUUID()}@example.test` } })).id;
		vi.spyOn(service as any, 'dispatch').mockImplementation(() => {});
		Reflect.defineMetadata('design:paramtypes', [AudioStoriesService], AudioStoriesController);
		const module = await Test.createTestingModule({
			controllers: [AudioStoriesController],
			providers: [
				{ provide: AudioStoriesService, useValue: service },
				{ provide: JwtService, useValue: jwt }
			]
		})
			.overrideGuard(AuthGuard)
			.useValue(new AuthGuard({ verifyAccessToken: (token: string) => jwt.verifyAsync(token) } as any))
			.compile();
		app = module.createNestApplication();
		app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
		await app.init();
	});
	beforeEach(async () => {
		await prisma.configuration.upsert({
			where: { key: 'credits_settings' },
			create: { key: 'credits_settings', value: {} },
			update: { value: {} }
		});
		await prisma.user.update({ where: { id: userId }, data: { creditBalance: 100, creditWelcomeGranted: true } });
		for (const key of Object.keys(limits)) delete limits[key];
		await prisma.storyAnalysisJob.updateMany({
			where: { userId, status: { in: ['QUEUED', 'WAITING', 'PROCESSING'] } },
			data: { status: 'CANCELLED' }
		});
		await prisma.aiUsageBucket.deleteMany();
		await prisma.aiRequestLease.deleteMany();
		dispatchProviderRequest = true;
		provider.analyze.mockReset().mockResolvedValue(result);
		provider.getModel.mockReset().mockResolvedValue('gemini-3.5-flash');
		provider.getConfiguration.mockReset().mockImplementation(async () => ({
			...defaultAnalysisSettings(await provider.getModel()),
			retryDelaySeconds: 1,
			retryLimit: 6
		}));
		storyId = (
			await service.create(userId, { title: 'Test', content: 'A simple unstructured story about a person.' })
		).id;
	});
	afterAll(async () => {
		await app?.close();
		await prisma.audioScene.deleteMany({ where: { story: { userId } } });
		await prisma.audioStory.deleteMany({ where: { userId } });
		await prisma.creditTransaction.deleteMany({ where: { userId } });
		await prisma.creditPurchase.deleteMany({ where: { userId } });
		await prisma.user.delete({ where: { id: userId } });
		await prisma.aiUsageBucket.deleteMany();
		await prisma.aiRequestLease.deleteMany();
		await prisma.$disconnect();
	});
	it('charges paid analysis once and reuses completed cached analysis for free', async () => {
		await prisma.configuration.update({
			where: { key: 'credits_settings' },
			data: { value: { analysisCredits: 10 } }
		});
		const j = (await service.analyze(storyId, userId))!;
		expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).creditBalance).toBe(90);
		await service.processAnalysisJob(j.id);
		await service.analyze(storyId, userId);
		expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).creditBalance).toBe(90);
		expect(await prisma.creditTransaction.count({ where: { userId, storyId, status: 'COMPLETED' } })).toBe(1);
	});
	it('refunds paid analysis on user cancellation', async () => {
		await prisma.configuration.update({
			where: { key: 'credits_settings' },
			data: { value: { analysisCredits: 10 } }
		});
		const j = (await service.analyze(storyId, userId))!;
		await service.cancelAnalysis(storyId, userId, j.id);
		expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).creditBalance).toBe(100);
	});

	it('reports invalid-key HTTP 400 as configuration failure and refunds the reservation', async () => {
		await prisma.configuration.update({
			where: { key: 'credits_settings' },
			data: { value: { analysisCredits: 10 } }
		});
		provider.analyze.mockRejectedValue(
			Object.assign(new Error('API key not valid. API_KEY_INVALID'), { status: 400 })
		);
		const j = (await service.analyze(storyId, userId))!;
		await service.processAnalysisJob(j.id);
		expect(await job(j.id)).toMatchObject({
			status: 'FAILED',
			errorCode: 'PROVIDER_CONFIGURATION_ERROR',
			providerHttpStatus: 400,
			attempts: 1
		});
		expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).creditBalance).toBe(100);
	});

	it('deduplicates concurrent submissions without consuming provider usage', async () => {
		const jobs = await Promise.all(Array.from({ length: 5 }, () => service.analyze(storyId, userId)));
		expect(new Set(jobs.map(j => j!.id)).size).toBe(1);
		expect(await prisma.aiUsageBucket.findMany()).toEqual([]);
		expect(JSON.stringify(jobs[0])).not.toContain('contentSnapshot');
	});
	it('retries busy responses in the same request then saves and caches success', async () => {
		provider.analyze.mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 503 }));
		const j = (await service.analyze(storyId, userId))!;
		await service.processAnalysisJob(j.id);
		expect(await job(j.id)).toMatchObject({
			status: 'COMPLETED',
			attempts: 2,
			providerHttpStatus: null,
			errorCode: null,
			errorMessage: null
		});
		expect(await prisma.audioScene.count({ where: { storyId } })).toBe(1);
		expect((await service.analyze(storyId, userId))!.id).toBe(j.id);
		expect(provider.analyze).toHaveBeenCalledTimes(2);
	});
	it('stores provider HTTP status during busy waits without exposing it to users', async () => {
		const j = (await service.analyze(storyId, userId))!;
		provider.analyze.mockRejectedValueOnce(Object.assign(new Error('private upstream detail'), { status: 503 }));
		await (service as any).processAnalysisAttempt(
			j.id,
			'fixture-model',
			'gemini',
			new AnalysisRun({ ...defaultAnalysisSettings('fixture-model'), retryDelaySeconds: 1 })
		);
		expect(await job(j.id)).toMatchObject({
			status: 'WAITING',
			providerHttpStatus: 503,
			errorCode: 'PROVIDER_BUSY'
		});
		expect(JSON.stringify(await service.getLatestAnalysisJob(storyId, userId))).not.toContain('providerHttpStatus');
	});
	it('fails after the configured primary retry limit and refunds the single paid job reservation', async () => {
		await prisma.configuration.update({
			where: { key: 'credits_settings' },
			data: { value: { analysisCredits: 10 } }
		});
		provider.getConfiguration.mockResolvedValueOnce({
			...defaultAnalysisSettings('g1'),
			retryDelaySeconds: 1,
			retryLimit: 1
		});
		provider.analyze.mockRejectedValue(Object.assign(new Error('busy'), { status: 503 }));
		const j = (await service.analyze(storyId, userId))!;
		await service.processAnalysisJob(j.id);
		expect(await job(j.id)).toMatchObject({
			status: 'FAILED',
			attempts: 2,
			errorCode: 'PROVIDER_BUSY',
			providerHttpStatus: 503
		});
		expect((await job(j.id)).errorMessage).not.toContain('automatically');
		expect(
			await prisma.creditTransaction.findUniqueOrThrow({ where: { reference: 'analysis:' + j.id } })
		).toMatchObject({ status: 'REFUNDED' });
		expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).creditBalance).toBe(100);
	});
	it('switches providers inside one job, charges once, and records OpenAI source', async () => {
		await prisma.configuration.update({
			where: { key: 'credits_settings' },
			data: { value: { analysisCredits: 10 } }
		});
		provider.getConfiguration.mockResolvedValueOnce({
			...defaultAnalysisSettings('g1'),
			providerFallback: true,
			retryLimit: 0,
			providers: {
				gemini: {
					primaryModel: 'g1',
					models: [
						{ id: 'g1', enabled: true },
						{ id: 'g2', enabled: true }
					]
				},
				openai: { primaryModel: 'o1', models: [{ id: 'o1', enabled: true }] }
			}
		});
		provider.analyze
			.mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 503 }))
			.mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 503 }));
		const j = (await service.analyze(storyId, userId))!;
		await service.processAnalysisJob(j.id);
		expect(await job(j.id)).toMatchObject({ status: 'COMPLETED', attempts: 3, source: 'OPENAI_AI' });
		expect(provider.analyze.mock.calls.map(c => [c[2], c[3]])).toEqual([
			['g1', 'gemini'],
			['g2', 'gemini'],
			['o1', 'openai']
		]);
		expect(await prisma.creditTransaction.count({ where: { reference: 'analysis:' + j.id } })).toBe(1);
		expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).creditBalance).toBe(90);
	});
	it('preserves per-job models, failures and snapshots across re-analysis and exposes paginated history', async () => {
		const configuration = {
			...defaultAnalysisSettings('g1'),
			retryLimit: 0,
			providers: {
				gemini: {
					primaryModel: 'g1',
					models: [
						{ id: 'g1', enabled: true },
						{ id: 'g2', enabled: true }
					]
				},
				openai: { primaryModel: null, models: [] }
			}
		};
		provider.getConfiguration.mockResolvedValue(configuration);
		provider.analyze.mockRejectedValueOnce(
			Object.assign(new Error('Busy apiKey=AIza-fixture-secret sk-fixturesecretlong'), {
				status: 503,
				code: 'UNAVAILABLE'
			})
		);
		const first = (await service.analyze(storyId, userId))!;
		await service.processAnalysisJob(first.id);
		const firstJob = await job(first.id);
		expect(firstJob).toMatchObject({
			status: 'COMPLETED',
			successfulProvider: 'gemini',
			successfulModel: 'g2',
			resultSnapshot: { source: 'GEMINI_AI' }
		});
		const history = await prisma.storyAnalysisAttempt.findMany({
			where: { jobId: first.id },
			orderBy: { sequence: 'asc' }
		});
		expect(history.map(a => [a.model, a.status, a.kind])).toEqual([
			['g1', 'FAILED', 'INITIAL'],
			['g2', 'COMPLETED', 'MODEL_FALLBACK']
		]);
		expect(history[0]).toMatchObject({
			providerHttpStatus: 503,
			providerErrorCode: 'UNAVAILABLE',
			errorCategory: 'BUSY'
		});
		expect(history[0].errorMessage).not.toContain('AIza');
		expect(history[0].errorMessage).not.toContain('sk-fixture');
		expect(history.every(a => a.durationMs !== null && a.durationMs >= 0 && a.finishedAt && a.responseAt)).toBe(
			true
		);
		expect((await service.analyze(storyId, userId))!.id).toBe(first.id);
		expect(await prisma.storyAnalysisAttempt.count({ where: { jobId: first.id } })).toBe(2);
		await service.update(storyId, userId, { content: 'A revised unstructured story about another day.' });
		provider.analyze.mockResolvedValueOnce({
			...result,
			scenes: result.scenes.map(scene => ({ ...scene, text: 'Revised dialogue' }))
		});
		const second = (await service.analyze(storyId, userId))!;
		await service.processAnalysisJob(second.id);
		expect(await job(second.id)).toMatchObject({ successfulModel: 'g1' });
		expect((await job(first.id)).resultSnapshot).toEqual(firstJob.resultSnapshot);
		expect((await job(second.id)).resultSnapshot).not.toEqual(firstJob.resultSnapshot);
		const admin = new AdminAnalysisJobsService(prisma as any);
		const detail = await admin.detail(first.id);
		expect(detail.job.resultSnapshot).toEqual(firstJob.resultSnapshot);
		expect(detail.currentStoryAnalysis.result).not.toEqual(firstJob.resultSnapshot);
		const page = await admin.attempts(first.id, { limit: 1 });
		expect(page.attempts).toHaveLength(1);
		expect(page.nextCursor).toBe(history[0].id);
		expect((await admin.attempts(first.id, { limit: 1, cursor: page.nextCursor! })).attempts[0].id).toBe(
			history[1].id
		);
		const sizes = await prisma.$queryRaw<
			Array<{ logical: number; stored: number; attempt: number }>
		>`SELECT octet_length(j."resultSnapshot"::text)::int AS logical,pg_column_size(j."resultSnapshot")::int AS stored,(SELECT pg_column_size(a)::int FROM "StoryAnalysisAttempt" a WHERE a."jobId"=j.id LIMIT 1) AS attempt FROM "StoryAnalysisJob" j WHERE j.id=${first.id}`;
		console.log('Synthetic one-scene history storage bytes:', sizes[0]);
	});
	it('measures a synthetic 100-scene job snapshot without duplicating results per attempt', async () => {
		const large = {
			characters: result.characters,
			scenes: Array.from({ length: 100 }, (_, i) => ({
				...result.scenes[0],
				sceneOrder: i + 1,
				text: `दृश्य ${i + 1}: यह कहानी का एक अलग संवाद है। ${Array.from({ length: 8 }, () => randomUUID()).join(' ')}`
			}))
		};
		provider.analyze.mockResolvedValueOnce(large);
		const j = (await service.analyze(storyId, userId))!;
		await service.processAnalysisJob(j.id);
		expect((await job(j.id)).status).toBe('COMPLETED');
		expect(await prisma.storyAnalysisAttempt.count({ where: { jobId: j.id } })).toBe(1);
		const sizes = await prisma.$queryRaw<
			Array<{ logical: number; stored: number }>
		>`SELECT octet_length("resultSnapshot"::text)::int AS logical,pg_column_size("resultSnapshot")::int AS stored FROM "StoryAnalysisJob" WHERE id=${j.id}`;
		console.log('Synthetic 100-scene snapshot bytes:', sizes[0]);
	});
	it('does not invent a provider attempt when configuration fails before dispatch', async () => {
		dispatchProviderRequest = false;
		provider.analyze.mockRejectedValue(
			Object.assign(new Error('Provider key unavailable'), { status: 503, nonRetryable: true })
		);
		const j = (await service.analyze(storyId, userId))!;
		await service.processAnalysisJob(j.id);
		expect(await prisma.storyAnalysisAttempt.count({ where: { jobId: j.id } })).toBe(0);
		expect((await job(j.id)).successfulModel).toBeNull();
	});
	it('records interrupted running attempts on stale-job cleanup without counting model failure', async () => {
		const j = (await service.analyze(storyId, userId))!;
		const startedAt = new Date(Date.now() - 180000);
		await prisma.storyAnalysisJob.update({
			where: { id: j.id },
			data: { status: 'PROCESSING', leaseToken: 'old-lease', leaseExpiresAt: startedAt, updatedAt: startedAt }
		});
		await prisma.storyAnalysisAttempt.create({
			data: { jobId: j.id, sequence: 1, provider: 'gemini', model: 'g1', kind: 'INITIAL', startedAt }
		});
		await service.waitForAnalysis(storyId, userId, j.id);
		expect(await prisma.storyAnalysisAttempt.findFirstOrThrow({ where: { jobId: j.id } })).toMatchObject({
			status: 'INTERRUPTED',
			errorCategory: 'WORKER_INTERRUPTED'
		});
	});
	it('honors a configured primary retry limit above three until success', async () => {
		for (let i = 0; i < 5; i++)
			provider.analyze.mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 503 }));
		const j = (await service.analyze(storyId, userId))!;
		await service.processAnalysisJob(j.id);
		expect(await job(j.id)).toMatchObject({ status: 'COMPLETED', attempts: 6, nextRetryAt: null });
		expect(provider.analyze).toHaveBeenCalledTimes(6);
	});
	it('keeps the starting model during busy retries when the setting changes', async () => {
		provider.getModel.mockResolvedValueOnce('gemini-starting-model').mockResolvedValue('gemini-new-model');
		provider.analyze.mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 503 }));
		const j = (await service.analyze(storyId, userId))!;
		await service.processAnalysisJob(j.id);
		expect(provider.getModel).toHaveBeenCalledTimes(1);
		expect(provider.analyze.mock.calls.map(call => call[2])).toEqual([
			'gemini-starting-model',
			'gemini-starting-model'
		]);
	});
	it('stops busy retries as soon as a different error arrives', async () => {
		for (let i = 0; i < 4; i++)
			provider.analyze.mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 503 }));
		provider.analyze.mockRejectedValueOnce(Object.assign(new Error('quota reached'), { status: 429 }));
		const j = (await service.analyze(storyId, userId))!;
		await service.processAnalysisJob(j.id);
		expect(await job(j.id)).toMatchObject({
			status: 'FAILED',
			attempts: 5,
			errorCode: 'PROVIDER_RATE_LIMITED',
			providerHttpStatus: 429,
			nextRetryAt: null
		});
		await service.processAnalysisJob(j.id);
		expect(provider.analyze).toHaveBeenCalledTimes(5);
	});
	it('wait endpoint observes actual dispatch without polling or another provider call', async () => {
		vi.mocked((service as any).dispatch).mockRestore();
		try {
			const j = (await service.analyze(storyId, userId))!;
			const token = jwt.sign({ sub: userId });
			await request(app.getHttpServer()).get(`/audio-stories/${storyId}/analysis-jobs/${j.id}/wait`).expect(401);
			const response = await request(app.getHttpServer())
				.get(`/audio-stories/${storyId}/analysis-jobs/${j.id}/wait`)
				.set('Authorization', `Bearer ${token}`)
				.expect(200);
			expect(response.body.status).toBe('COMPLETED');
			expect(provider.analyze).toHaveBeenCalledTimes(1);
			await expect(service.waitForAnalysis(storyId, userId + 10000, j.id)).rejects.toThrow();
		} finally {
			vi.spyOn(service as any, 'dispatch').mockImplementation(() => {});
		}
	});
	it('cancel wakes a long primary delay and prevents further provider calls', async () => {
		provider.getConfiguration.mockResolvedValueOnce({
			...defaultAnalysisSettings('g1'),
			retryDelaySeconds: 120,
			retryLimit: 1
		});
		provider.analyze.mockRejectedValue(Object.assign(new Error('busy'), { status: 503 }));
		const j = (await service.analyze(storyId, userId))!;
		const work = service.processAnalysisJob(j.id);
		for (let i = 0; i < 100 && (await job(j.id)).status !== 'WAITING'; i++)
			await new Promise(resolve => setTimeout(resolve, 10));
		await service.cancelAnalysis(storyId, userId, j.id);
		await Promise.race([
			work,
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error('Cancellation did not wake retry wait')), 2000)
			)
		]);
		expect((await job(j.id)).status).toBe('CANCELLED');
		expect(provider.analyze).toHaveBeenCalledTimes(1);
	});
	it('distinguishes application capacity from provider/network failures', async () => {
		const cases = [
			{ error: new AiCapacityError(new Date(Date.now() + 60000)), code: 'APP_CAPACITY_LIMIT' },
			{ error: Object.assign(new Error('quota'), { status: 429 }), code: 'PROVIDER_RATE_LIMITED' },
			{ error: new Error('fetch failed'), code: 'NETWORK_ERROR' }
		];
		for (const entry of cases) {
			provider.analyze.mockRejectedValueOnce(entry.error);
			const j = (await service.analyze(storyId, userId))!;
			await service.processAnalysisJob(j.id);
			expect(await job(j.id)).toMatchObject({
				status: 'FAILED',
				errorCode: entry.code,
				attempts: 1,
				nextRetryAt: null
			});
			await service.cancelAnalysis(storyId, userId, j.id);
		}
	});
	it('does not retry administrator-disabled or missing-credential errors', async () => {
		provider.analyze.mockRejectedValue(
			Object.assign(new Error('No enabled provider key'), { status: 503, nonRetryable: true })
		);
		const j = (await service.analyze(storyId, userId))!;
		await service.processAnalysisJob(j.id);
		expect(await job(j.id)).toMatchObject({
			status: 'FAILED',
			attempts: 1,
			errorCode: 'PROVIDER_CONFIGURATION_ERROR'
		});
		expect(provider.analyze).toHaveBeenCalledTimes(1);
	});
	it('does not retry permanent authorization failures or expose provider keys', async () => {
		provider.analyze.mockRejectedValue(Object.assign(new Error('AIzaSecretCredentials'), { status: 403 }));
		const j = (await service.analyze(storyId, userId))!;
		await service.processAnalysisJob(j.id);
		expect(await job(j.id)).toMatchObject({ status: 'FAILED' });
		expect(JSON.stringify(await service.findOne(storyId, userId))).not.toContain('AIza');
	});
	it('fails malformed output immediately', async () => {
		provider.analyze.mockRejectedValue(Object.assign(new Error('invalid'), { code: 'INVALID_ANALYSIS_RESPONSE' }));
		const j = (await service.analyze(storyId, userId))!;
		for (let i = 0; i < 3; i++) {
			await prisma.storyAnalysisJob.update({ where: { id: j.id }, data: { nextRetryAt: new Date(0) } });
			await service.processAnalysisJob(j.id);
		}
		expect(await job(j.id)).toMatchObject({ status: 'FAILED', attempts: 1 });
	});
	it('cancellation fences a late provider result', async () => {
		let finish!: (v: any) => void;
		provider.analyze.mockImplementation(
			() =>
				new Promise(r => {
					finish = r;
				})
		);
		const j = (await service.analyze(storyId, userId))!;
		const work = service.processAnalysisJob(j.id);
		for (let i = 0; i < 100 && !finish; i++) await new Promise(r => setTimeout(r, 10));
		await service.cancelAnalysis(storyId, userId, j.id);
		finish(result);
		await work;
		expect((await job(j.id)).status).toBe('CANCELLED');
		expect(await prisma.storyAnalysisAttempt.findFirstOrThrow({ where: { jobId: j.id } })).toMatchObject({
			status: 'CANCELLED',
			errorCategory: 'USER_CANCELLED'
		});
		expect((await job(j.id)).resultSnapshot).toBeNull();
		expect((await job(j.id)).successfulModel).toBeNull();
		expect(await prisma.audioScene.count({ where: { storyId } })).toBe(0);
		expect((await service.findOne(storyId, userId)).analysisStatus).toBe('PENDING');
	});
	it('editing cancels queued analysis and blocks another user', async () => {
		const j = (await service.analyze(storyId, userId))!;
		await expect(service.cancelAnalysis(storyId, userId + 10000, j.id)).rejects.toThrow();
		await service.update(storyId, userId, { content: 'Changed script' });
		await service.processAnalysisJob(j.id);
		expect((await job(j.id)).status).toBe('CANCELLED');
		expect(provider.analyze).not.toHaveBeenCalled();
	});
	it('settles a model lookup failure without leaving queued paid analysis', async () => {
		await prisma.configuration.update({
			where: { key: 'credits_settings' },
			data: { value: { analysisCredits: 10 } }
		});
		const j = (await service.analyze(storyId, userId))!;
		provider.getModel.mockRejectedValueOnce(new Error('Settings temporarily unavailable'));
		await service.processAnalysisJob(j.id);
		expect(await job(j.id)).toMatchObject({
			status: 'FAILED',
			errorCode: 'ANALYSIS_SETUP_FAILED',
			leaseToken: null
		});
		expect((await prisma.audioStory.findUniqueOrThrow({ where: { id: storyId } })).analysisStatus).toBe('FAILED');
		expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).creditBalance).toBe(100);
		expect(
			await prisma.creditTransaction.count({ where: { reference: 'analysis:' + j.id, status: 'REFUNDED' } })
		).toBe(1);
		expect(provider.analyze).not.toHaveBeenCalled();
	});
	it('setup failure cannot overwrite an analysis worker claimed during model lookup', async () => {
		const j = (await service.analyze(storyId, userId))!;
		provider.getModel.mockImplementationOnce(async () => {
			await prisma.storyAnalysisJob.update({
				where: { id: j.id },
				data: { status: 'PROCESSING', leaseToken: 'new-owner', leaseExpiresAt: new Date(Date.now() + 120000) }
			});
			throw new Error('Settings unavailable');
		});
		await service.processAnalysisJob(j.id);
		expect(await job(j.id)).toMatchObject({ status: 'PROCESSING', leaseToken: 'new-owner' });
		expect(
			await prisma.creditTransaction.count({ where: { reference: 'analysis:' + j.id, status: 'RESERVED' } })
		).toBe(1);
		await service.cancelAnalysis(storyId, userId, j.id);
	});
	it('interruption recovery cannot fail a worker claimed after its initial stale read', async () => {
		const j = (await service.analyze(storyId, userId))!;
		await prisma.storyAnalysisJob.update({
			where: { id: j.id },
			data: { status: 'WAITING', leaseToken: null, leaseExpiresAt: null, updatedAt: new Date(0) }
		});
		const original = prisma.storyAnalysisJob.findFirst.bind(prisma.storyAnalysisJob);
		const spy = vi.spyOn(prisma.storyAnalysisJob as any, 'findFirst').mockImplementationOnce(async (query: any) => {
			const snapshot = await original(query);
			await prisma.storyAnalysisJob.update({
				where: { id: j.id },
				data: { status: 'PROCESSING', leaseToken: 'fresh-owner', leaseExpiresAt: new Date(Date.now() + 120000) }
			});
			return snapshot;
		});
		try {
			await service.waitForAnalysis(storyId, userId, j.id);
		} finally {
			spy.mockRestore();
		}
		expect(await job(j.id)).toMatchObject({ status: 'PROCESSING', leaseToken: 'fresh-owner' });
		expect(
			await prisma.creditTransaction.count({ where: { reference: 'analysis:' + j.id, status: 'RESERVED' } })
		).toBe(1);
		await service.cancelAnalysis(storyId, userId, j.id);
	});

	it('fails expired workers after restart without retrying', async () => {
		const j = (await service.analyze(storyId, userId))!;
		await prisma.storyAnalysisJob.update({
			where: { id: j.id },
			data: { status: 'PROCESSING', leaseToken: 'old-worker', leaseExpiresAt: new Date(0) }
		});
		await service.onModuleInit();
		expect(await job(j.id)).toMatchObject({ status: 'FAILED', errorCode: 'WORKER_INTERRUPTED' });
		expect(provider.analyze).not.toHaveBeenCalled();
	});
	it('does not enforce old per-minute or daily submission caps', async () => {
		limits.AI_SUBMISSIONS_PER_MINUTE = '1';
		limits.AI_SUBMISSIONS_PER_DAY = '1';
		for (let i = 0; i < 5; i++) {
			const story = await service.create(userId, { title: 'Other', content: 'Another story' });
			const submitted = (await service.analyze(story.id, userId))!;
			expect(submitted.status).toBe('QUEUED');
			await service.cancelAnalysis(story.id, userId, submitted.id);
		}
		expect(await prisma.aiUsageBucket.findMany()).toEqual([]);
	});
	it('analysis bypasses exhausted application budgets and active AI leases', async () => {
		limits.AI_USER_REQUESTS_PER_DAY = '1';
		limits.AI_USER_CONCURRENCY = '1';
		await usage.execute(userId, 'tts', 10, async () => true);
		await prisma.aiRequestLease.create({
			data: { id: randomUUID(), userId, kind: 'tts', expiresAt: new Date(Date.now() + 60000) }
		});
		const before = await prisma.aiUsageBucket.findMany({ orderBy: { key: 'asc' } });
		for (let i = 0; i < 6; i++) expect(await usage.execute(userId, 'analysis', 10, async () => 'ok')).toBe('ok');
		expect(await prisma.aiUsageBucket.findMany({ orderBy: { key: 'asc' } })).toEqual(before);
		await expect(usage.execute(userId, 'tts', 10, async () => true)).rejects.toBeInstanceOf(AiCapacityError);
	});
	it('does not apply custom user or global analysis job-count caps', async () => {
		limits.ANALYSIS_USER_ACTIVE_JOBS = '1';
		limits.ANALYSIS_GLOBAL_WORKERS = '1';
		const first = (await service.analyze(storyId, userId))!;
		const other = await service.create(userId, { title: 'Other', content: 'Another story' });
		const second = (await service.analyze(other.id, userId))!;
		await prisma.storyAnalysisJob.update({
			where: { id: first.id },
			data: { status: 'PROCESSING', leaseExpiresAt: new Date(Date.now() + 60000) }
		});
		await service.processAnalysisJob(second.id);
		expect((await job(second.id)).status).toBe('COMPLETED');
	});
	it('shares a daily TTS budget across service instances', async () => {
		limits.AI_USER_REQUESTS_PER_DAY = '1';
		await usage.execute(userId, 'tts', 10, async () => true);
		const otherUsage = new AiUsageService(
			prisma as any,
			config as any,
			new AppSettingsService(prisma as any, config as any)
		);
		const action = vi.fn();
		await expect(otherUsage.execute(userId, 'tts', 10, action)).rejects.toBeInstanceOf(AiCapacityError);
		expect(action).not.toHaveBeenCalled();
		expect(await prisma.aiRequestLease.count()).toBe(0);
	});
	it('enforces concurrency across instances and releases leases on error', async () => {
		let finish!: () => void;
		const active = usage.execute(
			userId,
			'tts',
			10,
			() =>
				new Promise<void>(r => {
					finish = r;
				})
		);
		for (let i = 0; i < 100 && !finish; i++) await new Promise(r => setTimeout(r, 10));
		const other = new AiUsageService(
			prisma as any,
			config as any,
			new AppSettingsService(prisma as any, config as any)
		);
		await expect(other.execute(userId, 'tts', 1, async () => true)).rejects.toBeInstanceOf(AiCapacityError);
		finish();
		await active;
		await expect(
			usage.execute(userId, 'tts', 1, async () => {
				throw new Error('provider failed');
			})
		).rejects.toThrow('provider failed');
		expect(await prisma.aiRequestLease.count()).toBe(0);
	});
	it('rejects oversized calls before reaching the provider and redacts secrets', async () => {
		const action = vi.fn();
		await expect(usage.execute(userId, 'analysis', 40001, action)).rejects.toThrow('too large');
		expect(action).not.toHaveBeenCalled();
		expect(safeAiError(new Error('AIzaAbc_123 https://x?key=secret&x=1 Bearer token.value'))).toBe(
			'[redacted] https://x?key=[redacted]&x=1 Bearer [redacted]'
		);
	});
	it('accepts analysis over HTTP with 202 and enforces authentication and ownership', async () => {
		await request(app.getHttpServer()).post(`/audio-stories/${storyId}/analyze`).expect(401);
		const auth = { Authorization: `Bearer ${jwt.sign({ id: userId })}` };
		const response = await request(app.getHttpServer())
			.post(`/audio-stories/${storyId}/analyze`)
			.set(auth)
			.expect(202);
		expect(response.body.status).toBe('QUEUED');
		await request(app.getHttpServer())
			.get(`/audio-stories/${storyId}/analysis-jobs/latest`)
			.set({ Authorization: `Bearer ${jwt.sign({ id: userId + 99999 })}` })
			.expect(404);
		await request(app.getHttpServer())
			.post(`/audio-stories/${storyId}/analysis-jobs/${response.body.id}/cancel`)
			.set(auth)
			.expect(201);
		expect((await job(response.body.id)).status).toBe('CANCELLED');
	});
	it('uses local parser for valid structured scripts without a provider call', async () => {
		await service.update(storyId, userId, {
			content: 'SCENE 1\nTTS PROMPT — Narrator | Male | Calm, Narrative\n"Hello world"'
		});
		const j = (await service.analyze(storyId, userId))!;
		await service.processAnalysisJob(j.id);
		expect(await job(j.id)).toMatchObject({
			status: 'COMPLETED',
			source: 'LOCAL_PARSER',
			successfulModel: null,
			successfulProvider: null
		});
		expect(await prisma.storyAnalysisAttempt.count({ where: { jobId: j.id } })).toBe(0);
		expect((await job(j.id)).resultSnapshot).not.toBeNull();
		expect(provider.analyze).not.toHaveBeenCalled();
	});
	it('denies diagnostic provider calls unless the user is explicitly allowlisted', async () => {
		const ai = Object.assign(Object.create(AiService.prototype), { configService: config });
		await expect(ai.testGemini(userId)).rejects.toMatchObject({ status: 403 });
		limits.AI_DIAGNOSTICS_USER_IDS = String(userId);
		expect(() => ai.assertDiagnosticsAccess(userId)).not.toThrow();
	});
});
