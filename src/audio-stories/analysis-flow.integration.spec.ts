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
describe.skipIf(!databaseUrl)('durable analysis and shared AI budgets', () => {
	const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl! }) });
	const limits: Record<string, string> = {};
	const config = { get: (key: string) => limits[key] };
	const usage = new AiUsageService(prisma as any, config as any);
	const provider = { analyze: vi.fn() };
	const service = new AudioStoriesService(
		prisma as any,
		provider as any,
		new StoryParserService(),
		new StoryAnalysisValidatorService(),
		config as any,
		usage
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
			.useValue(new AuthGuard(jwt))
			.compile();
		app = module.createNestApplication();
		app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
		await app.init();
	});
	beforeEach(async () => {
		for (const key of Object.keys(limits)) delete limits[key];
		await prisma.storyAnalysisJob.updateMany({
			where: { userId, status: { in: ['QUEUED', 'WAITING', 'PROCESSING'] } },
			data: { status: 'CANCELLED' }
		});
		await prisma.aiUsageBucket.deleteMany();
		await prisma.aiRequestLease.deleteMany();
		provider.analyze.mockReset().mockResolvedValue(result);
		storyId = (
			await service.create(userId, { title: 'Test', content: 'A simple unstructured story about a person.' })
		).id;
	});
	afterAll(async () => {
		await app?.close();
		service.onModuleDestroy();
		await prisma.audioScene.deleteMany({ where: { story: { userId } } });
		await prisma.audioStory.deleteMany({ where: { userId } });
		await prisma.user.delete({ where: { id: userId } });
		await prisma.aiUsageBucket.deleteMany();
		await prisma.aiRequestLease.deleteMany();
		await prisma.$disconnect();
	});
	it('deduplicates concurrent submissions without charging them twice', async () => {
		const jobs = await Promise.all(Array.from({ length: 5 }, () => service.analyze(storyId, userId)));
		expect(new Set(jobs.map(j => j!.id)).size).toBe(1);
		expect(await prisma.aiUsageBucket.findMany()).toEqual(
			expect.arrayContaining([expect.objectContaining({ requests: 1 })])
		);
		expect(JSON.stringify(jobs[0])).not.toContain('contentSnapshot');
	});
	it('persists overload, retries the same job, then saves scenes atomically', async () => {
		provider.analyze.mockRejectedValueOnce(Object.assign(new Error('overloaded'), { status: 503 }));
		const j = (await service.analyze(storyId, userId))!;
		await service.processAnalysisJob(j.id);
		expect((await job(j.id)).status).toBe('WAITING');
		expect((await service.findOne(storyId, userId)).analysisStatus).toBe('PROCESSING');
		await prisma.storyAnalysisJob.update({ where: { id: j.id }, data: { nextRetryAt: new Date(0) } });
		await service.processAnalysisJob(j.id);
		expect(await job(j.id)).toMatchObject({ status: 'COMPLETED', attempts: 2 });
		expect(await prisma.audioScene.count({ where: { storyId } })).toBe(1);
		const cached = (await service.analyze(storyId, userId))!;
		expect(cached.id).toBe(j.id);
		expect(provider.analyze).toHaveBeenCalledTimes(2);
	});
	it('does not retry permanent authorization failures or expose provider keys', async () => {
		provider.analyze.mockRejectedValue(Object.assign(new Error('AIzaSecretCredentials'), { status: 403 }));
		const j = (await service.analyze(storyId, userId))!;
		await service.processAnalysisJob(j.id);
		expect(await job(j.id)).toMatchObject({ status: 'FAILED' });
		expect(JSON.stringify(await service.findOne(storyId, userId))).not.toContain('AIza');
	});
	it('retries malformed output a finite number of times', async () => {
		provider.analyze.mockRejectedValue(Object.assign(new Error('invalid'), { code: 'INVALID_ANALYSIS_RESPONSE' }));
		const j = (await service.analyze(storyId, userId))!;
		for (let i = 0; i < 3; i++) {
			await prisma.storyAnalysisJob.update({ where: { id: j.id }, data: { nextRetryAt: new Date(0) } });
			await service.processAnalysisJob(j.id);
		}
		expect(await job(j.id)).toMatchObject({ status: 'FAILED', attempts: 3 });
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
	it('recovers expired leases after restart', async () => {
		const j = (await service.analyze(storyId, userId))!;
		await prisma.storyAnalysisJob.update({
			where: { id: j.id },
			data: { status: 'PROCESSING', leaseToken: 'old-worker', leaseExpiresAt: new Date(0) }
		});
		await service.scanAnalysisJobs();
		expect((await job(j.id)).status).toBe('WAITING');
		await service.processAnalysisJob(j.id);
		expect((await job(j.id)).status).toBe('COMPLETED');
	});
	it('limits submissions without creating a rejected job', async () => {
		limits.AI_SUBMISSIONS_PER_MINUTE = '1';
		await service.analyze(storyId, userId);
		const other = await service.create(userId, { title: 'Other', content: 'Another story' });
		await expect(service.analyze(other.id, userId)).rejects.toMatchObject({ status: 429 });
		expect(await prisma.storyAnalysisJob.count({ where: { storyId: other.id } })).toBe(0);
	});
	it('shares a daily provider budget across analysis and TTS services', async () => {
		limits.AI_USER_REQUESTS_PER_DAY = '1';
		await usage.execute(userId, 'analysis', 10, async () => true);
		const otherUsage = new AiUsageService(prisma as any, config as any);
		const action = vi.fn();
		await expect(otherUsage.execute(userId, 'tts', 10, action)).rejects.toBeInstanceOf(AiCapacityError);
		expect(action).not.toHaveBeenCalled();
		expect(await prisma.aiRequestLease.count()).toBe(0);
	});
	it('enforces concurrency across instances and releases leases on error', async () => {
		let finish!: () => void;
		const active = usage.execute(
			userId,
			'analysis',
			10,
			() =>
				new Promise<void>(r => {
					finish = r;
				})
		);
		for (let i = 0; i < 100 && !finish; i++) await new Promise(r => setTimeout(r, 10));
		const other = new AiUsageService(prisma as any, config as any);
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
		expect(await job(j.id)).toMatchObject({ status: 'COMPLETED', source: 'LOCAL_PARSER' });
		expect(provider.analyze).not.toHaveBeenCalled();
	});
	it('denies diagnostic provider calls unless the user is explicitly allowlisted', async () => {
		const ai = Object.assign(Object.create(AiService.prototype), { configService: config });
		await expect(ai.testGemini(userId)).rejects.toMatchObject({ status: 403 });
		limits.AI_DIAGNOSTICS_USER_IDS = String(userId);
		expect(() => ai.assertDiagnosticsAccess(userId)).not.toThrow();
	});
});
