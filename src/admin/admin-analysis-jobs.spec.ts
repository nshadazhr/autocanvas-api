import 'reflect-metadata';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { AdminAnalysisJobsController } from './admin-analysis-jobs.controller.js';
import { AdminAnalysisJobsService } from './admin-analysis-jobs.service.js';
import { AdminAnalysisJobsQuery } from './dto/admin-analysis-jobs.dto.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TokenService } from '../auth/services/token.service.js';
import { AdminAuthGuard } from '../auth/auth.guard.js';
import { AdminGuard } from '../auth/services/admin.guard.js';
const id = '11111111-1111-4111-8111-111111111111';
const next = '22222222-2222-4222-8222-222222222222';
const content = 'Submitted story';
const summary = {
	id,
	storyId: 4,
	userId: 8,
	status: 'FAILED',
	attempts: 3,
	nextRetryAt: null,
	errorCode: 'NETWORK_ERROR',
	errorMessage: '?key=private-key Bearer private-token',
	source: null,
	createdAt: new Date('2026-10-01T12:00:00Z'),
	updatedAt: new Date('2026-10-01T12:02:00Z'),
	completedAt: new Date('2026-10-01T12:02:00Z'),
	story: { title: 'Fixture story' }
};
const prisma = {
	user: {
		findUnique: vi.fn(async ({ where }: any) => ({
			id: where.id,
			role: where.id === 1 ? 'ADMIN' : where.id === 2 ? 'SUPERADMIN' : 'USER'
		}))
	},
	storyAnalysisJob: {
		findMany: vi.fn(async (_query: any) => [summary, { ...summary, id: next }]),
		findUnique: vi.fn(async () => ({
			...summary,
			contentSnapshot: content,
			contentHash: createHash('sha256').update(content).digest('hex'),
			story: {
				title: 'Changed story',
				content: 'Changed script',
				analysisStatus: 'COMPLETED',
				analyzedAt: new Date(),
				analysisResult: { characters: [{ name: 'Narrator' }], scenes: [] }
			}
		}))
	}
};
describe('admin analysis monitoring with existing guards and fixture persistence', () => {
	let app: INestApplication;
	beforeAll(async () => {
		Reflect.defineMetadata('design:paramtypes', [PrismaService], AdminAnalysisJobsService);
		Reflect.defineMetadata('design:paramtypes', [PrismaService], AdminGuard);
		Reflect.defineMetadata('design:paramtypes', [TokenService], AdminAuthGuard);
		Reflect.defineMetadata('design:paramtypes', [AdminAnalysisJobsService], AdminAnalysisJobsController);
		Reflect.defineMetadata(
			'design:paramtypes',
			[AdminAnalysisJobsQuery],
			AdminAnalysisJobsController.prototype,
			'list'
		);
		Reflect.defineMetadata('design:paramtypes', [String], AdminAnalysisJobsController.prototype, 'detail');
		const module = await Test.createTestingModule({
			controllers: [AdminAnalysisJobsController],
			providers: [
				AdminAnalysisJobsService,
				AdminAuthGuard,
				AdminGuard,
				{ provide: PrismaService, useValue: prisma },
				{
					provide: TokenService,
					useValue: {
						verifyAccessToken: async (t: string, realm: string) => ({
							id: Number(t),
							realm: t === '9' ? 'user' : realm
						})
					}
				}
			]
		}).compile();
		app = module.createNestApplication();
		app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
		await app.init();
	});
	afterAll(async () => app.close());
	const auth = (role = '1') => ({ Authorization: 'Bearer ' + role });
	it('requires an admin realm/current admin role and offers no mutation routes', async () => {
		await request(app.getHttpServer()).get('/admin/analysis-jobs').expect(401);
		await request(app.getHttpServer()).get('/admin/analysis-jobs').set(auth('3')).expect(403);
		await request(app.getHttpServer()).get('/admin/analysis-jobs').set(auth('9')).expect(401);
		await request(app.getHttpServer()).post('/admin/analysis-jobs').set(auth()).expect(404);
		await request(app.getHttpServer()).get('/admin/analysis-jobs').set(auth('2')).expect(200);
	});
	it('validates IDs, dates, status, page size and query allowlist', async () => {
		for (const query of [
			'limit=101',
			'limit=0',
			'cursor=bad',
			'status=PARTIAL',
			'from=2026-02-30',
			'userId=0',
			'from=2026-10-02&to=2026-10-01',
			'unknown=1'
		])
			await request(app.getHttpServer())
				.get('/admin/analysis-jobs?' + query)
				.set(auth())
				.expect(400);
		await request(app.getHttpServer()).get('/admin/analysis-jobs/not-a-uuid').set(auth()).expect(400);
	});
	it('filters and paginates by timestamp plus UUID, redacts errors and omits script/lease secrets from lists', async () => {
		const res = await request(app.getHttpServer())
			.get(
				'/admin/analysis-jobs?limit=1&cursor=' +
					id +
					'&search=4&status=FAILED&userId=8&from=2026-10-01&to=2026-10-01'
			)
			.set(auth())
			.expect(200);
		expect(res.body.jobs).toHaveLength(1);
		expect(res.body.nextCursor).toBe(id);
		expect(res.headers['cache-control']).toBe('private, no-store');
		expect(JSON.stringify(res.body)).not.toContain('private-key');
		expect(JSON.stringify(res.body)).not.toContain('private-token');
		const q = prisma.storyAnalysisJob.findMany.mock.calls.at(-1)![0] as any;
		expect(q.where.status).toBe('FAILED');
		expect(q.where.userId).toBe(8);
		expect(q.where.createdAt.lt.toISOString()).toBe('2026-10-02T00:00:00.000Z');
		expect(q.where.AND[0].OR[1].id.lt).toBe(id);
		expect(q.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
		expect(q.select.contentSnapshot).toBeUndefined();
		expect(q.select.leaseToken).toBeUndefined();
	});
	it('returns the submitted snapshot separately from clearly scoped current-story data', async () => {
		const res = await request(app.getHttpServer())
			.get('/admin/analysis-jobs/' + id)
			.set(auth())
			.expect(200);
		expect(res.body.job.contentSnapshot).toBe(content);
		expect(res.body.currentStoryAnalysis.contentMatchesJob).toBe(false);
		expect(res.body.currentStoryAnalysis.result.characters[0].name).toBe('Narrator');
		expect(res.body.job.leaseToken).toBeUndefined();
	});
	it('handles missing jobs and deleted cursor records', async () => {
		prisma.storyAnalysisJob.findUnique.mockResolvedValueOnce(null as any);
		await request(app.getHttpServer())
			.get('/admin/analysis-jobs/' + id)
			.set(auth())
			.expect(404);
		prisma.storyAnalysisJob.findUnique.mockResolvedValueOnce(null as any);
		await request(app.getHttpServer())
			.get('/admin/analysis-jobs?cursor=' + id)
			.set(auth())
			.expect(400);
	});
});
