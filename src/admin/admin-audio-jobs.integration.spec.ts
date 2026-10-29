import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../prisma/prisma.service.js';
import { TokenService } from '../auth/services/token.service.js';
import { AdminAuthGuard } from '../auth/auth.guard.js';
import { AdminGuard } from '../auth/services/admin.guard.js';
import { AdminAudioJobsService } from './admin-audio-jobs.service.js';
import { AdminAudioJobsController } from './admin-audio-jobs.controller.js';
import { AdminAudioJobsQuery } from './dto/admin-audio-jobs.dto.js';
import { AdminPageQuery } from '../auth/dto/admin-role.dto.js';
const url = process.env.AUDIO_FLOW_TEST_DATABASE_URL;
if (url) {
	const parsed = new URL(url);
	if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
		throw new Error('Disposable local test database required');
}
describe.skipIf(!url)('read-only admin audio jobs with PostgreSQL and real session guards', () => {
	const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) });
	const tokens = new TokenService(
		new JwtService({ secret: 'jobs-test-access', signOptions: { expiresIn: '15m' } }),
		prisma as any
	);
	let app: INestApplication;
	let admin: any, superadmin: any, owner: any;
	let adminToken: any, superToken: any, userToken: any;
	let story: any, otherStory: any;
	let failed: any, processing: any, done: any;
	const users: number[] = [];
	const oldSecret = process.env.JWT_REFRESH_SECRET;
	const auth = (t: any) => ({ Authorization: `Bearer ${t.access_token}` });
	beforeAll(async () => {
		process.env.JWT_REFRESH_SECRET = 'jobs-test-refresh';
		await prisma.$connect();
		for (const role of ['ADMIN', 'SUPERADMIN', 'USER'] as const) {
			const u = await prisma.user.create({ data: { email: `jobs-${randomUUID()}@example.test`, role } });
			users.push(u.id);
			if (role === 'ADMIN') admin = u;
			else if (role === 'SUPERADMIN') superadmin = u;
			else owner = u;
		}
		adminToken = await tokens.generateTokens(admin, 'admin');
		superToken = await tokens.generateTokens(superadmin, 'admin');
		userToken = await tokens.generateTokens(owner, 'user');
		story = await prisma.audioStory.create({
			data: { userId: owner.id, title: 'Admin monitoring fixture', analysisStatus: 'COMPLETED' }
		});
		otherStory = await prisma.audioStory.create({ data: { userId: owner.id, title: 'Other job fixture' } });
		failed = await prisma.audioGenerationJob.create({
			data: {
				userId: owner.id,
				storyId: story.id,
				status: 'PARTIAL',
				totalScenes: 2,
				failedScenes: 1,
				created_at: new Date('2026-10-10T23:59:59Z')
			}
		});
		processing = await prisma.audioGenerationJob.create({
			data: { userId: owner.id, storyId: story.id, status: 'PROCESSING', totalScenes: 1 }
		});
		done = await prisma.audioGenerationJob.create({
			data: { userId: owner.id, storyId: otherStory.id, status: 'COMPLETED' }
		});
		for (let n = 1; n <= 2; n++) {
			const scene = await prisma.audioScene.create({
				data: { storyId: story.id, sceneOrder: n, text: 'Private scene text', speakerName: 'Narrator' }
			});
			await prisma.audioGenerationJobItem.create({
				data: {
					jobId: failed.id,
					sceneId: scene.id,
					storyId: story.id,
					status: n === 1 ? 'FAILED' : 'COMPLETED',
					attempts: 2,
					error: n === 1 ? 'Provider refused ?key=private-secret Bearer secret-token' : null,
					textSnapshot: 'Private scene text'
				}
			});
		}
		Reflect.defineMetadata('design:paramtypes', [AdminAudioJobsService], AdminAudioJobsController);
		Reflect.defineMetadata(
			'design:paramtypes',
			[AdminAudioJobsQuery],
			AdminAudioJobsController.prototype,
			'list'
		);
		Reflect.defineMetadata(
			'design:paramtypes',
			[Number, AdminPageQuery],
			AdminAudioJobsController.prototype,
			'detail'
		);
		const module = await Test.createTestingModule({
			controllers: [AdminAudioJobsController],
			providers: [
				{ provide: PrismaService, useValue: prisma },
				{ provide: TokenService, useValue: tokens },
				{ provide: AdminAudioJobsService, useValue: new AdminAudioJobsService(prisma as any) },
				{ provide: AdminAuthGuard, useValue: new AdminAuthGuard(tokens) },
				{ provide: AdminGuard, useValue: new AdminGuard(prisma as any) }
			]
		}).compile();
		app = module.createNestApplication();
		app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
		await app.init();
	});
	afterAll(async () => {
		await app?.close();
		if (users.length) await prisma.user.deleteMany({ where: { id: { in: users } } });
		await prisma.$disconnect();
		if (oldSecret === undefined) delete process.env.JWT_REFRESH_SECRET;
		else process.env.JWT_REFRESH_SECRET = oldSecret;
	});
	it('rejects missing/user tokens for list and details', async () => {
		for (const path of ['/admin/audio-jobs', '/admin/audio-jobs/' + failed.id]) {
			await request(app.getHttpServer()).get(path).expect(401);
			await request(app.getHttpServer()).get(path).set(auth(userToken)).expect(401);
		}
	});
	it('allows ADMIN and SUPERADMIN to monitor jobs belonging to another account', async () => {
		for (const token of [adminToken, superToken]) {
			const r = await request(app.getHttpServer())
				.get('/admin/audio-jobs?userId=' + owner.id)
				.set(auth(token))
				.expect(200);
			expect(r.headers['cache-control']).toBe('private, no-store');
			expect(r.body.jobs.map((j: any) => j.id)).toEqual([done.id, processing.id, failed.id]);
			expect(r.body.jobs[0].userId).toBe(owner.id);
			expect(JSON.stringify(r.body)).not.toContain(owner.email);
		}
	});
	it('combines status/story/user/search filters', async () => {
		const r = await request(app.getHttpServer())
			.get(`/admin/audio-jobs?status=PARTIAL&storyId=${story.id}&userId=${owner.id}&search=monitoring`)
			.set(auth(adminToken))
			.expect(200);
		expect(r.body.jobs.map((j: any) => j.id)).toEqual([failed.id]);
		const exact = await request(app.getHttpServer())
			.get('/admin/audio-jobs?search=' + done.id)
			.set(auth(adminToken))
			.expect(200);
		expect(exact.body.jobs.some((j: any) => j.id === done.id)).toBe(true);
	});
	it('uses descending cursor pagination without overlap', async () => {
		const first = await request(app.getHttpServer())
			.get(`/admin/audio-jobs?userId=${owner.id}&limit=2`)
			.set(auth(adminToken))
			.expect(200);
		expect(first.body.jobs.map((j: any) => j.id)).toEqual([done.id, processing.id]);
		const second = await request(app.getHttpServer())
			.get(`/admin/audio-jobs?userId=${owner.id}&limit=2&cursor=${first.body.nextCursor}`)
			.set(auth(adminToken))
			.expect(200);
		expect(second.body.jobs.map((j: any) => j.id)).toEqual([failed.id]);
		expect(second.body.nextCursor).toBe(null);
	});
	it('includes the entire final UTC date', async () => {
		const r = await request(app.getHttpServer())
			.get('/admin/audio-jobs?from=2026-10-10&to=2026-10-10')
			.set(auth(adminToken))
			.expect(200);
		expect(r.body.jobs.map((j: any) => j.id)).toContain(failed.id);
	});
	it('rejects invalid filters, page bounds and date ranges', async () => {
		for (const query of [
			'status=BOGUS',
			'userId=-1',
			'storyId=999999999999',
			'cursor=999999999999',
			'limit=101',
			'limit=0',
			'from=2026-02-31',
			'from=2026-10-12&to=2026-10-10',
			'extra=true'
		])
			await request(app.getHttpServer())
				.get('/admin/audio-jobs?' + query)
				.set(auth(adminToken))
				.expect(400);
		await request(app.getHttpServer())
			.get('/admin/audio-jobs/999999999999')
			.set(auth(adminToken))
			.expect(400);
	});
	it('returns bounded scene details with redacted errors and no text/storage snapshots', async () => {
		const r = await request(app.getHttpServer())
			.get(`/admin/audio-jobs/${failed.id}?limit=1`)
			.set(auth(adminToken))
			.expect(200);
		expect(r.body.items).toHaveLength(1);
		expect(r.body.items[0].error).toContain('[redacted]');
		expect(JSON.stringify(r.body)).not.toContain('private-secret');
		expect(JSON.stringify(r.body)).not.toContain('secret-token');
		expect(JSON.stringify(r.body)).not.toContain('Private scene text');
		expect(JSON.stringify(r.body)).not.toContain('filePath');
		const next = await request(app.getHttpServer())
			.get(`/admin/audio-jobs/${failed.id}?limit=1&cursor=${r.body.nextCursor}`)
			.set(auth(adminToken))
			.expect(200);
		expect(next.body.items[0].id).not.toBe(r.body.items[0].id);
		expect(next.body.nextCursor).toBe(null);
	});
	it('returns not found for missing jobs and an empty filtered list', async () => {
		await request(app.getHttpServer()).get('/admin/audio-jobs/2147483647').set(auth(adminToken)).expect(404);
		const r = await request(app.getHttpServer())
			.get('/admin/audio-jobs?search=does-not-exist-' + randomUUID())
			.set(auth(adminToken))
			.expect(200);
		expect(r.body.jobs).toEqual([]);
		expect(r.body.nextCursor).toBe(null);
	});
	it('exposes no retry/cancel admin mutations and leaves user jobs unchanged', async () => {
		for (const action of ['retry', 'cancel'])
			await request(app.getHttpServer())
				.post(`/admin/audio-jobs/${processing.id}/${action}`)
				.set(auth(superToken))
				.send({})
				.expect(404);
		expect((await prisma.audioGenerationJob.findUnique({ where: { id: processing.id } }))?.status).toBe(
			'PROCESSING'
		);
	});
	it('checks current role and revoked sessions', async () => {
		await prisma.user.update({ where: { id: admin.id }, data: { role: 'USER' } });
		await request(app.getHttpServer()).get('/admin/audio-jobs').set(auth(adminToken)).expect(403);
		await tokens.revokeSession(superToken.refresh_token, 'admin');
		await request(app.getHttpServer()).get('/admin/audio-jobs').set(auth(superToken)).expect(401);
	});
});
