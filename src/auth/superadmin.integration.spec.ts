import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../prisma/prisma.service.js';
import { AdminRolesController } from './admin-roles.controller.js';
import { AdminRoleService } from './services/admin-role.service.js';
import { SuperAdminGuard } from './services/superadmin.guard.js';
import { AdminAuthGuard } from './auth.guard.js';
import { AuthOriginGuard } from './services/auth-origin.guard.js';
import { TokenService } from './services/token.service.js';
import { AdminPageQuery, AdminUsersQuery, ChangeAdminRoleDto } from './dto/admin-role.dto.js';
const databaseUrl = process.env.AUDIO_FLOW_TEST_DATABASE_URL;
if (databaseUrl) {
	const url = new URL(databaseUrl);
	if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.endsWith('_test'))
		throw new Error('Disposable local test database required');
}
describe.skipIf(!databaseUrl)('superadmin roles and immutable audit with real PostgreSQL/HTTP', () => {
	const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl! }) });
	const jwt = new JwtService({ secret: 'superadmin-test-access', signOptions: { expiresIn: '15m' } });
	const tokens = new TokenService(jwt, prisma as any);
	const service = new AdminRoleService(prisma as any);
	let app: INestApplication;
	let super1: any, super2: any, admin: any, target: any;
	let superToken: any, otherToken: any, adminToken: any, userToken: any;
	const oldSecret = process.env.JWT_REFRESH_SECRET;
	const headers = (token: any) => ({ Authorization: `Bearer ${token.access_token}` });
	const change = (actor: any, id: number, role: string, reason = 'Reviewed account permissions') =>
		request(app.getHttpServer()).patch(`/auth/admin/users/${id}/role`).set(headers(actor)).send({ role, reason });
	beforeAll(async () => {
		process.env.JWT_REFRESH_SECRET = 'superadmin-test-refresh';
		await prisma.$connect();
		const values = [];
		for (let n = 0; n < 4; n++)
			values.push(
				await prisma.user.create({
					data: {
						email: `superadmin-test-${randomUUID()}@example.test`,
						password: 'test-only-password-hash',
						email_verified_at: new Date()
					}
				})
			);
		[super1, super2, admin, target] = values;
		Reflect.defineMetadata('design:paramtypes', [AdminRoleService], AdminRolesController);
		Reflect.defineMetadata('design:paramtypes', [AdminUsersQuery], AdminRolesController.prototype, 'listUsers');
		Reflect.defineMetadata('design:paramtypes', [AdminPageQuery], AdminRolesController.prototype, 'listAudit');
		Reflect.defineMetadata(
			'design:paramtypes',
			[Number, ChangeAdminRoleDto, Object],
			AdminRolesController.prototype,
			'changeRole'
		);
		const module = await Test.createTestingModule({
			controllers: [AdminRolesController],
			providers: [
				{ provide: PrismaService, useValue: prisma },
				{ provide: TokenService, useValue: tokens },
				{ provide: AdminRoleService, useValue: service },
				{ provide: AdminAuthGuard, useValue: new AdminAuthGuard(tokens) },
				{ provide: SuperAdminGuard, useValue: new SuperAdminGuard(prisma as any) },
				{ provide: AuthOriginGuard, useValue: new AuthOriginGuard() }
			]
		}).compile();
		app = module.createNestApplication();
		app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
		await app.init();
	});
	beforeEach(async () => {
		await prisma.adminRoleAudit.deleteMany();
		await prisma.authSession.deleteMany();
		await prisma.user.updateMany({
			where: { id: { in: [super1.id, super2.id, admin.id, target.id] } },
			data: { role: 'USER', password: 'test-only-password-hash', email_verified_at: new Date() }
		});
		await prisma.user.update({ where: { id: super1.id }, data: { role: 'SUPERADMIN' } });
		await prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
		superToken = await tokens.generateTokens(super1, 'admin');
		otherToken = await tokens.generateTokens(super2, 'admin');
		adminToken = await tokens.generateTokens(admin, 'admin');
		userToken = await tokens.generateTokens(target, 'user');
	});
	afterAll(async () => {
		await app?.close();
		await prisma.adminRoleAudit.deleteMany();
		if (super1)
			await prisma.user.deleteMany({ where: { id: { in: [super1.id, super2.id, admin.id, target.id] } } });
		await prisma.$disconnect();
		if (oldSecret === undefined) delete process.env.JWT_REFRESH_SECRET;
		else process.env.JWT_REFRESH_SECRET = oldSecret;
	});
	it('rejects unauthenticated, normal user and ordinary admin access', async () => {
		await request(app.getHttpServer()).get('/auth/admin/users').expect(401);
		await request(app.getHttpServer()).get('/auth/admin/users').set(headers(userToken)).expect(401);
		await request(app.getHttpServer()).get('/auth/admin/users').set(headers(adminToken)).expect(403);
		await change(adminToken, target.id, 'ADMIN').expect(403);
		await request(app.getHttpServer()).get('/auth/admin/role-audit').set(headers(adminToken)).expect(403);
	});
	it('lists safe account fields with bounded pagination and filters', async () => {
		const page = await request(app.getHttpServer())
			.get('/auth/admin/users?limit=1')
			.set(headers(superToken))
			.expect(200);
		expect(page.body.users).toHaveLength(1);
		expect(page.body.nextCursor).toBeTruthy();
		expect(JSON.stringify(page.body)).not.toContain('password');
		const filtered = await request(app.getHttpServer())
			.get(`/auth/admin/users?role=ADMIN&search=${encodeURIComponent(admin.email)}`)
			.set(headers(superToken))
			.expect(200);
		expect(filtered.body.users.map((u: any) => u.id)).toEqual([admin.id]);
		await request(app.getHttpServer()).get('/auth/admin/users?limit=101').set(headers(superToken)).expect(400);
	});
	it('promotes an existing account, audits the actor/reason and revokes all target sessions', async () => {
		const existing = await tokens.generateTokens(target, 'admin');
		const response = await change(superToken, target.id, 'ADMIN').expect(200);
		expect(response.body).toMatchObject({ changed: true, user: { id: target.id, role: 'ADMIN' } });
		expect(JSON.stringify(response.body)).not.toContain('password');
		const audit = await prisma.adminRoleAudit.findFirstOrThrow();
		expect(audit).toMatchObject({
			actorId: super1.id,
			targetId: target.id,
			fromRole: 'USER',
			toRole: 'ADMIN',
			reason: 'Reviewed account permissions'
		});
		await expect(tokens.verifyAccessToken(userToken.access_token)).rejects.toMatchObject({ status: 401 });
		await expect(tokens.verifyRefreshToken(existing.refresh_token, 'admin')).rejects.toMatchObject({ status: 401 });
	});
	it('demotes an admin and rejects their old access and refresh tokens', async () => {
		await change(superToken, admin.id, 'USER').expect(200);
		await expect(tokens.verifyAccessToken(adminToken.access_token, 'admin')).rejects.toMatchObject({ status: 401 });
		await expect(tokens.verifyRefreshToken(adminToken.refresh_token, 'admin')).rejects.toMatchObject({
			status: 401
		});
	});
	it('allows a superadmin to grant SUPERADMIN to an eligible account', async () => {
		await change(superToken, target.id, 'SUPERADMIN').expect(200);
		expect(await prisma.user.count({ where: { role: 'SUPERADMIN' } })).toBe(2);
	});
	it('prevents demotion of the final superadmin without revoking the session or adding audit', async () => {
		await change(superToken, super1.id, 'USER').expect(409);
		expect(await prisma.adminRoleAudit.count()).toBe(0);
		await request(app.getHttpServer()).get('/auth/admin/users').set(headers(superToken)).expect(200);
	});
	it('serializes simultaneous self-demotions so one superadmin always remains', async () => {
		await prisma.user.update({ where: { id: super2.id }, data: { role: 'SUPERADMIN' } });
		const responses = await Promise.all([
			change(superToken, super1.id, 'USER'),
			change(otherToken, super2.id, 'USER')
		]);
		expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
		expect(await prisma.user.count({ where: { role: 'SUPERADMIN' } })).toBe(1);
		expect(await prisma.adminRoleAudit.count()).toBe(1);
	});
	it('rechecks actor privileges inside the role transaction', async () => {
		await prisma.user.update({ where: { id: super2.id }, data: { role: 'SUPERADMIN' } });
		await change(superToken, super2.id, 'USER').expect(200);
		const sid = jwt.decode(otherToken.access_token).sid;
		await expect(
			service.changeRole(super2.id, sid, target.id, { role: 'ADMIN', reason: 'Reviewed permissions' })
		).rejects.toMatchObject({ status: 403 });
	});
	it('rejects invalid roles, whitespace reasons, unknown fields and missing users', async () => {
		await change(superToken, target.id, 'ROOT').expect(400);
		await change(superToken, target.id, 'ADMIN', '     ').expect(400);
		await change(superToken, 2147483647, 'ADMIN').expect(404);
		await request(app.getHttpServer())
			.patch(`/auth/admin/users/${target.id}/role`)
			.set(headers(superToken))
			.send({ role: 'ADMIN', reason: 'Reviewed permissions', password: 'injected' })
			.expect(400);
		expect(await prisma.adminRoleAudit.count()).toBe(0);
	});
	it('does not grant privileged roles to unverified or passwordless accounts', async () => {
		await prisma.user.update({ where: { id: target.id }, data: { email_verified_at: null } });
		await change(superToken, target.id, 'ADMIN').expect(400);
		await prisma.user.update({ where: { id: target.id }, data: { email_verified_at: new Date(), password: null } });
		await change(superToken, target.id, 'SUPERADMIN').expect(400);
	});
	it('treats same-role requests as no-ops without redundant session revocation', async () => {
		await change(superToken, admin.id, 'ADMIN')
			.expect(200)
			.expect(r => expect(r.body.changed).toBe(false));
		expect(await prisma.adminRoleAudit.count()).toBe(0);
		await expect(tokens.verifyAccessToken(adminToken.access_token, 'admin')).resolves.toMatchObject({
			id: admin.id
		});
	});
	it('returns read-only role audit events to superadmins only', async () => {
		await change(superToken, target.id, 'ADMIN').expect(200);
		const response = await request(app.getHttpServer())
			.get('/auth/admin/role-audit?limit=1')
			.set(headers(superToken))
			.expect(200);
		expect(response.body.events).toHaveLength(1);
		expect(response.body.events[0]).toMatchObject({ actorId: super1.id, targetId: target.id });
		await request(app.getHttpServer())
			.delete(`/auth/admin/users/${super1.id}`)
			.set(headers(superToken))
			.expect(404);
	});
	it('bootstrap is server-only, audited, idempotent and disabled once another superadmin exists', async () => {
		await expect(service.bootstrap(target.email)).rejects.toMatchObject({ status: 409 });
		await prisma.user.update({ where: { id: super1.id }, data: { role: 'USER' } });
		const result = await service.bootstrap(` ${target.email.toUpperCase()} `);
		expect(result).toMatchObject({ changed: true, user: { id: target.id, role: 'SUPERADMIN' } });
		expect(await prisma.adminRoleAudit.findFirst()).toMatchObject({
			action: 'SUPERADMIN_BOOTSTRAPPED',
			actorId: null,
			targetId: target.id
		});
		expect((await service.bootstrap(target.email)).changed).toBe(false);
		expect(await prisma.adminRoleAudit.count()).toBe(1);
		await request(app.getHttpServer()).post('/auth/admin/bootstrap').expect(404);
	});
	it('bootstrap refuses missing, unverified and passwordless accounts', async () => {
		await prisma.user.update({ where: { id: super1.id }, data: { role: 'USER' } });
		await expect(service.bootstrap('missing@example.test')).rejects.toMatchObject({ status: 404 });
		await prisma.user.update({ where: { id: target.id }, data: { email_verified_at: null } });
		await expect(service.bootstrap(target.email)).rejects.toMatchObject({ status: 400 });
		await prisma.user.update({ where: { id: target.id }, data: { email_verified_at: new Date(), password: null } });
		await expect(service.bootstrap(target.email)).rejects.toMatchObject({ status: 400 });
	});
	it('denies role changes initiated by the user application origin', async () => {
		await change(superToken, target.id, 'ADMIN').set('Origin', 'http://localhost:3000').expect(403);
		await change(superToken, target.id, 'ADMIN').set('Origin', 'http://localhost:3001').expect(200);
	});
	it('rolls back the role and session changes if the audit write fails', async () => {
		const failing = new AdminRoleService({
			$transaction: (work: any, options: any) =>
				prisma.$transaction(
					tx =>
						work(
							new Proxy(tx, {
								get(target, key) {
									if (key === 'adminRoleAudit')
										return {
											create: async () => {
												throw new Error('Audit unavailable');
											}
										};
									return Reflect.get(target, key);
								}
							})
						),
					options
				)
		} as any);
		await expect(
			failing.changeRole(super1.id, jwt.decode(superToken.access_token).sid, target.id, {
				role: 'ADMIN',
				reason: 'Reviewed permissions'
			})
		).rejects.toThrow('Audit unavailable');
		expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).role).toBe('USER');
		expect(await prisma.adminRoleAudit.count()).toBe(0);
		await expect(tokens.verifyAccessToken(userToken.access_token)).resolves.toMatchObject({ id: target.id });
	});
	it('serializes first-superadmin bootstrap attempts', async () => {
		await prisma.user.update({ where: { id: super1.id }, data: { role: 'USER' } });
		const results = await Promise.allSettled([service.bootstrap(target.email), service.bootstrap(super2.email)]);
		expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
		expect(await prisma.user.count({ where: { role: 'SUPERADMIN' } })).toBe(1);
		expect(await prisma.adminRoleAudit.count()).toBe(1);
	});
});
