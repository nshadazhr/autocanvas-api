import 'reflect-metadata';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../prisma/prisma.service.js';
import { TokenService } from '../auth/services/token.service.js';
import { AdminAuthGuard } from '../auth/auth.guard.js';
import { AdminGuard } from '../auth/services/admin.guard.js';
import { AdminAnalysisPerformanceController } from './admin-analysis-performance.controller.js';
import { AdminAnalysisPerformanceService } from './admin-analysis-performance.service.js';
import { AdminAnalysisPerformanceQuery } from './dto/admin-analysis-performance.dto.js';
const url = process.env.AUDIO_FLOW_TEST_DATABASE_URL;
if (url && (!['localhost', '127.0.0.1'].includes(new URL(url).hostname) || !new URL(url).pathname.endsWith('_test')))
	throw Error('Disposable local *_test DB required');
describe.skipIf(!url)('analysis performance with real PostgreSQL', () => {
	const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) });
	const service = new AdminAnalysisPerformanceService(prisma as any);
	let app: INestApplication, adminId: number, userId: number, storyId: number, jobId: string;
	let sequence = 0;
	async function add(data: any) {
		return prisma.storyAnalysisAttempt.create({
			data: {
				jobId,
				sequence: ++sequence,
				provider: 'gemini',
				model: 'g1',
				kind: 'INITIAL',
				startedAt: new Date(),
				status: 'COMPLETED',
				durationMs: 100,
				...data
			}
		});
	}
	const query = (extra: Partial<AdminAnalysisPerformanceQuery> = {}) =>
		Object.assign(new AdminAnalysisPerformanceQuery(), extra);
	beforeAll(async () => {
		const admin = await prisma.user.create({
			data: { email: `perf-admin-${randomUUID()}@example.test`, role: 'ADMIN' }
		});
		adminId = admin.id;
		const user = await prisma.user.create({
			data: { email: `perf-user-${randomUUID()}@example.test`, role: 'USER' }
		});
		userId = user.id;
		const story = await prisma.audioStory.create({
			data: { userId, title: 'Performance fixture', content: 'Private original script' }
		});
		storyId = story.id;
		const job = await prisma.storyAnalysisJob.create({
			data: {
				userId,
				storyId,
				contentHash: 'fixture',
				contentSnapshot: story.content,
				status: 'COMPLETED',
				successfulProvider: 'openai',
				successfulModel: 'o1'
			}
		});
		jobId = job.id;
		await add({ durationMs: 100 });
		await add({ durationMs: 300 });
		await add({ status: 'FAILED', errorCategory: 'BUSY', providerHttpStatus: 503, durationMs: 200 });
		await add({ status: 'FAILED', errorCategory: 'RATE_LIMITED', providerHttpStatus: 429 });
		await add({ status: 'CANCELLED' });
		await add({ status: 'INTERRUPTED' });
		await add({ status: 'RUNNING', durationMs: null });
		await add({ status: 'FAILED', errorCategory: 'COMMIT_FAILED' });
		await add({ provider: 'openai', model: 'o1', durationMs: 1000 });
		await add({ model: 'cancelled-only', status: 'CANCELLED' });
		await add({ startedAt: new Date(Date.now() - 40 * 86400000), durationMs: 9999 });
		await add({ startedAt: new Date(Date.now() + 86400000), model: 'future' });
		await prisma.storyAnalysisJob.create({
			data: {
				userId,
				storyId,
				contentHash: 'local',
				contentSnapshot: story.content,
				status: 'COMPLETED',
				source: 'LOCAL_PARSER'
			}
		});
		Reflect.defineMetadata(
			'design:paramtypes',
			[AdminAnalysisPerformanceService],
			AdminAnalysisPerformanceController
		);
		Reflect.defineMetadata(
			'design:paramtypes',
			[AdminAnalysisPerformanceQuery],
			AdminAnalysisPerformanceController.prototype,
			'get'
		);
		Reflect.defineMetadata('design:paramtypes', [PrismaService], AdminGuard);
		Reflect.defineMetadata('design:paramtypes', [TokenService], AdminAuthGuard);
		const module = await Test.createTestingModule({
			controllers: [AdminAnalysisPerformanceController],
			providers: [
				{ provide: AdminAnalysisPerformanceService, useValue: service },
				{ provide: PrismaService, useValue: prisma },
				{
					provide: TokenService,
					useValue: {
						verifyAccessToken: async (t: string, realm: string) => {
							if (t === 'invalid') throw Error();
							return {
								id: t === 'user-realm' ? adminId : Number(t),
								realm: t === 'user-realm' ? 'user' : realm
							};
						}
					}
				},
				AdminAuthGuard,
				AdminGuard
			]
		}).compile();
		app = module.createNestApplication();
		app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
		await app.init();
	});
	afterAll(async () => {
		await app?.close();
		await prisma.audioStory.deleteMany({ where: { id: storyId } });
		await prisma.user.deleteMany({ where: { id: { in: [adminId, userId] } } });
		await prisma.$disconnect();
	});
	it('computes weighted totals, actual medians and exclusions without cached/local work', async () => {
		const result = await service.overview(query());
		expect(result.totals).toMatchObject({
			recordedAttempts: 10,
			completedAttempts: 5,
			successes: 3,
			failures: 2,
			busyErrors: 1,
			rateLimitErrors: 1,
			running: 1,
			cancelled: 2,
			interrupted: 1,
			localFailures: 1,
			successRate: 60,
			busyRate: 20,
			medianSuccessMs: 300,
			latencySamples: 3
		});
		expect(result.totals.avgSuccessMs).toBeCloseTo(1400 / 3);
		const g = result.models.find(m => m.provider === 'gemini' && m.model === 'g1')!;
		expect(g).toMatchObject({
			completedAttempts: 4,
			successRate: 50,
			busyRate: 25,
			medianSuccessMs: 200,
			avgSuccessMs: 200
		});
		expect(result.recentJobs.map(j => j.id)).toEqual([jobId]);
		expect(JSON.stringify(result)).not.toContain('Private original script');
	});
	it('filters provider/model and returns null rates and latencies for absent or excluded-only data', async () => {
		expect((await service.overview(query({ provider: 'openai' }))).totals).toMatchObject({
			completedAttempts: 1,
			successRate: 100,
			medianSuccessMs: 1000
		});
		expect((await service.overview(query({ provider: 'gemini', model: 'cancelled-only' }))).totals).toMatchObject({
			completedAttempts: 0,
			cancelled: 1,
			successRate: null,
			busyRate: null,
			medianSuccessMs: null,
			avgSuccessMs: null
		});
		const empty = await service.overview(query({ model: 'missing' }));
		expect(empty.models).toEqual([]);
		expect(empty.recentJobs).toEqual([]);
		expect(empty.totals.recordedAttempts).toBe(0);
	});
	it('uses request-start UTC ranges and keeps page cohorts fixed by asOf', async () => {
		expect((await service.overview(query({ days: 90 }))).totals.completedAttempts).toBe(6);
		const first = await service.overview(query({ limit: 1 }));
		expect(first.models).toHaveLength(1);
		expect(first.nextPage).toBe(2);
		const late = await add({ model: 'aa-new-model', startedAt: new Date(Date.parse(first.to) + 1) });
		try {
			const second = await service.overview(query({ limit: 1, page: 2, asOf: first.to }));
			expect(second.to).toBe(first.to);
			expect(second.models[0].model).not.toBe(first.models[0].model);
			expect(second.totals.recordedAttempts).toBe(first.totals.recordedAttempts);
		} finally {
			await prisma.storyAnalysisAttempt.delete({ where: { id: late.id } });
		}
	});
	it('enforces read-only admin realm/role, private responses and strict query validation', async () => {
		const endpoint = '/admin/analysis-performance';
		await request(app.getHttpServer()).get(endpoint).expect(401);
		await request(app.getHttpServer()).get(endpoint).set('Authorization', 'Bearer user-realm').expect(401);
		await request(app.getHttpServer()).get(endpoint).set('Authorization', `Bearer ${userId}`).expect(403);
		const ok = await request(app.getHttpServer())
			.get(endpoint)
			.set('Authorization', `Bearer ${adminId}`)
			.expect(200);
		expect(ok.headers['cache-control']).toBe('private, no-store');
		expect(ok.body.totals.successRate).toBe(60);
		for (const suffix of [
			'days=8',
			'days=0',
			'provider=other',
			'page=0',
			'limit=101',
			'model=bad/slash',
			'unknown=true',
			'asOf=bad'
		])
			await request(app.getHttpServer())
				.get(`${endpoint}?${suffix}`)
				.set('Authorization', `Bearer ${adminId}`)
				.expect(400);
		await request(app.getHttpServer())
			.post(endpoint)
			.set('Authorization', `Bearer ${adminId}`)
			.send({})
			.expect(404);
	});
});
