import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, AudioJobStatus } from '../generated/prisma/client.js';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../prisma/prisma.service.js';
import { TokenService } from '../auth/services/token.service.js';
import { AdminAuthGuard } from '../auth/auth.guard.js';
import { AdminGuard } from '../auth/services/admin.guard.js';
import { AdminDashboardController } from './admin-dashboard.controller.js';
import { AdminDashboardService } from './admin-dashboard.service.js';
const databaseUrl = process.env.AUDIO_FLOW_TEST_DATABASE_URL;
if (databaseUrl) {
	const url = new URL(databaseUrl);
	if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.endsWith('_test'))
		throw new Error('Disposable local test database required');
}
describe.skipIf(!databaseUrl)('admin dashboard PostgreSQL/HTTP reporting', () => {
	const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl! }) });
	const jwt = new JwtService({ secret: 'dashboard-test-access', signOptions: { expiresIn: '15m' } });
	const tokens = new TokenService(jwt, prisma as any);
	let app: INestApplication;
	let admin: any, superadmin: any, member: any;
	let adminToken: any, superToken: any, memberToken: any;
	const users: number[] = [];
	let baselineUsers: number, baselineProjects: number, baselineJobs: number;
	const oldSecret = process.env.JWT_REFRESH_SECRET;
	const auth = (token: any) => ({ Authorization: `Bearer ${token.access_token}` });
	beforeAll(async () => {
		process.env.JWT_REFRESH_SECRET = 'dashboard-test-refresh';
		await prisma.$connect();
		baselineUsers = await prisma.user.count();
		baselineProjects =
			(await prisma.project.count()) +
			(await prisma.audioStory.count()) +
			(await prisma.animationProject.count());
		baselineJobs = await prisma.audioGenerationJob.count();
		for (const role of ['ADMIN', 'SUPERADMIN', 'USER'] as const) {
			const account = await prisma.user.create({
				data: {
					email: `dashboard-${randomUUID()}@example.test`,
					role,
					name: role,
					email_verified_at: new Date()
				}
			});
			users.push(account.id);
			if (role === 'ADMIN') admin = account;
			else if (role === 'SUPERADMIN') superadmin = account;
			else member = account;
		}
		adminToken = await tokens.generateTokens(admin, 'admin');
		superToken = await tokens.generateTokens(superadmin, 'admin');
		memberToken = await tokens.generateTokens(member, 'user');
		Reflect.defineMetadata('design:paramtypes', [AdminDashboardService], AdminDashboardController);
		const module = await Test.createTestingModule({
			controllers: [AdminDashboardController],
			providers: [
				{ provide: PrismaService, useValue: prisma },
				{ provide: TokenService, useValue: tokens },
				{ provide: AdminDashboardService, useValue: new AdminDashboardService(prisma as any) },
				{ provide: AdminAuthGuard, useValue: new AdminAuthGuard(tokens) },
				{ provide: AdminGuard, useValue: new AdminGuard(prisma as any) }
			]
		}).compile();
		app = module.createNestApplication();
		await app.init();
	});
	afterAll(async () => {
		await app?.close();
		if (users.length) await prisma.user.deleteMany({ where: { id: { in: users } } });
		await prisma.$disconnect();
		if (oldSecret === undefined) delete process.env.JWT_REFRESH_SECRET;
		else process.env.JWT_REFRESH_SECRET = oldSecret;
	});
	it('rejects missing and user-audience tokens', async () => {
		await request(app.getHttpServer()).get('/admin/dashboard').expect(401);
		await request(app.getHttpServer()).get('/admin/dashboard').set(auth(memberToken)).expect(401);
	});
	it('allows ordinary admins but excludes account details', async () => {
		const r = await request(app.getHttpServer()).get('/admin/dashboard').set(auth(adminToken)).expect(200);
		expect(r.headers['cache-control']).toBe('private, no-store');
		expect(r.body.canViewUsers).toBe(false);
		expect(r.body.recentUsers).toEqual([]);
		expect(r.body.totals.users).toBe(baselineUsers + 3);
		expect(r.body.userGrowth).toHaveLength(30);
	});
	it('rejects invalid or unbounded day ranges', async () => {
		for (const days of ['1', '365', '7.5', 'oops', ''])
			await request(app.getHttpServer())
				.get('/admin/dashboard?days=' + days)
				.set(auth(adminToken))
				.expect(400);
	});
	it('returns genuine zeros and complete status buckets before jobs exist', async () => {
		const r = await request(app.getHttpServer())
			.get('/admin/dashboard?days=7')
			.set(auth(superToken))
			.expect(200);
		expect(r.body.totals.audioJobs).toBe(baselineJobs);
		expect(Object.keys(r.body.audioJobs.statuses).sort()).toEqual(Object.values(AudioJobStatus).sort());
		expect(r.body.userGrowth).toHaveLength(7);
		expect(r.body.userGrowth.every((p: any) => Number.isInteger(p.count) && p.count >= 0)).toBe(true);
	});
	it('counts all project kinds, job statuses and partial failures exactly once', async () => {
		await prisma.project.create({ data: { userId: member.id, name: 'Regular fixture' } });
		await prisma.animationProject.create({ data: { userId: member.id, name: 'Animation fixture' } });
		const story = await prisma.audioStory.create({ data: { userId: member.id, title: 'Reporting fixture' } });
		await prisma.audioGenerationJob.createMany({
			data: Object.values(AudioJobStatus).map((status) => ({ storyId: story.id, userId: member.id, status }))
		});
		const r = await request(app.getHttpServer())
			.get('/admin/dashboard?days=7')
			.set(auth(superToken))
			.expect(200);
		expect(r.body.totals.projects).toBe(baselineProjects + 3);
		expect(r.body.totals.audioJobs).toBe(baselineJobs + 7);
		expect(Object.values(r.body.audioJobs.statuses).reduce((sum: any, n: any) => sum + n, 0)).toBe(
			r.body.totals.audioJobs
		);
		expect(r.body.totals.failedJobs).toBe(
			r.body.audioJobs.statuses.FAILED + r.body.audioJobs.statuses.PARTIAL
		);
		expect(r.body.recentFailedJobs.every((j: any) => ['FAILED', 'PARTIAL'].includes(j.status))).toBe(true);
		expect(r.body.recentFailedJobs.find((j: any) => j.storyId === story.id).story.title).toBe(
			'Reporting fixture'
		);
	});
	it('returns bounded safe recent users, including newly registered accounts', async () => {
		const r = await request(app.getHttpServer()).get('/admin/dashboard').set(auth(superToken)).expect(200);
		expect(r.body.canViewUsers).toBe(true);
		expect(r.body.recentUsers.length).toBeLessThanOrEqual(5);
		expect(r.body.recentUsers.some((u: any) => u.id === member.id)).toBe(true);
		for (const u of r.body.recentUsers)
			expect(Object.keys(u).sort()).toEqual(
				['id', 'name', 'email', 'email_verified_at', 'created_at'].sort()
			);
	});
	it('buckets UTC dates, excludes older registrations and zero-fills days', async () => {
		const today = new Date();
		today.setUTCHours(0, 0, 0, 0);
		const recent = new Date(today);
		recent.setUTCDate(recent.getUTCDate() - 2);
		recent.setUTCHours(23, 59, 59);
		const older = new Date(today);
		older.setUTCDate(older.getUTCDate() - 35);
		const before = await request(app.getHttpServer())
			.get('/admin/dashboard?days=7')
			.set(auth(superToken))
			.expect(200);
		for (const created_at of [recent, older]) {
			const u = await prisma.user.create({
				data: { email: `dashboard-${randomUUID()}@example.test`, created_at }
			});
			users.push(u.id);
		}
		const after = await request(app.getHttpServer())
			.get('/admin/dashboard?days=7')
			.set(auth(superToken))
			.expect(200);
		expect(after.body.userGrowth.map((p: any) => p.date)).toEqual(
			Array.from({ length: 7 }, (_, i) => {
				const d = new Date(today);
				d.setUTCDate(d.getUTCDate() - 6 + i);
				return d.toISOString().slice(0, 10);
			})
		);
		const day = recent.toISOString().slice(0, 10);
		expect(after.body.userGrowth.find((p: any) => p.date === day).count).toBe(
			before.body.userGrowth.find((p: any) => p.date === day).count + 1
		);
		expect(after.body.userGrowth.reduce((sum: number, p: any) => sum + p.count, 0)).toBe(
			before.body.userGrowth.reduce((sum: number, p: any) => sum + p.count, 0) + 1
		);
	});
	it('checks current database role, not only the signed claim', async () => {
		await prisma.user.update({ where: { id: admin.id }, data: { role: 'USER' } });
		try {
			await request(app.getHttpServer()).get('/admin/dashboard').set(auth(adminToken)).expect(403);
		} finally {
			await prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
		}
	});
	it('rejects a revoked admin session', async () => {
		await tokens.revokeSession(adminToken.refresh_token, 'admin');
		await request(app.getHttpServer()).get('/admin/dashboard').set(auth(adminToken)).expect(401);
	});
});
