import { UserService } from '../user/user.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConfigService } from '@nestjs/config';
import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard, AdminAuthGuard } from './auth.guard.js';
import { AdminGuard } from './services/admin.guard.js';
import { TokenService } from './services/token.service.js';
import { LoginRateGuard } from './services/login-rate.guard.js';
import { AuthOriginGuard } from './services/auth-origin.guard.js';
import { authAllowedOrigins } from './services/auth-origins.js';
import { LoginDto } from './dto/register.dto.js';
const databaseUrl = process.env.AUDIO_FLOW_TEST_DATABASE_URL;
if (databaseUrl) {
	const url = new URL(databaseUrl);
	if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.endsWith('_test'))
		throw new Error('Disposable local test database required');
}
describe.skipIf(!databaseUrl)('admin/user auth with real PostgreSQL and HTTP', () => {
	const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl! }) });
	const jwt = new JwtService({ secret: 'isolated-auth-test-access', signOptions: { expiresIn: '15m' } });
	const tokens = new TokenService(jwt, prisma as any);
	const limits: Record<string, string> = {};
	const users = new UserService(prisma as any);
	const passwords = { verify: vi.fn(async (raw: string) => raw === 'correct-password') };
	const auth = new AuthService({} as any, users as any, passwords as any, tokens, {} as any, {} as any, {} as any);
	let app: INestApplication;
	let admin: any, user: any, superadmin: any;
	const oldSecret = process.env.JWT_REFRESH_SECRET;
	const login = (person: any, adminMode = true) =>
		request(app.getHttpServer())
			.post(adminMode ? '/auth/admin/login' : '/auth/login')
			.send({ email: person.email, password: 'correct-password' });
	const cookie = (response: any, name: string) =>
		(response.headers['set-cookie'] as string[]).find(value => value.startsWith(name + '='))!.split(';')[0];
	const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
	beforeAll(async () => {
		process.env.JWT_REFRESH_SECRET = 'isolated-auth-test-refresh';
		await prisma.$connect();
		for (const role of ['USER', 'ADMIN', 'SUPERADMIN'] as const) {
			const value = await prisma.user.create({
				data: {
					email: `${role.toLowerCase()}-${randomUUID()}@example.test`,
					role,
					password: 'test-password-hash'
				}
			});
			if (role === 'USER') user = value;
			else if (role === 'ADMIN') admin = value;
			else superadmin = value;
		}
		Reflect.defineMetadata('design:paramtypes', [AuthService], AuthController);
		for (const method of ['login', 'adminLogin'])
			Reflect.defineMetadata('design:paramtypes', [LoginDto, Object], AuthController.prototype, method);
		const module = await Test.createTestingModule({
			controllers: [AuthController],
			providers: [
				{ provide: PrismaService, useValue: prisma },
				{ provide: ConfigService, useValue: { get: (key: string) => limits[key] } },
				{ provide: TokenService, useValue: tokens },
				{ provide: AuthService, useValue: auth },
				{ provide: AuthGuard, useValue: new AuthGuard(tokens) },
				{ provide: AdminAuthGuard, useValue: new AdminAuthGuard(tokens) },
				{ provide: AdminGuard, useValue: new AdminGuard(prisma as any) },
				{ provide: AuthOriginGuard, useValue: new AuthOriginGuard() },
				{
					provide: LoginRateGuard,
					useValue: new LoginRateGuard(prisma as any, { get: (key: string) => limits[key] } as any)
				}
			]
		}).compile();
		app = module.createNestApplication();
		app.use(cookieParser());
		app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
		app.enableCors({ origin: authAllowedOrigins(), credentials: true });
		await app.init();
	});
	beforeEach(async () => {
		for (const key of Object.keys(limits)) delete limits[key];
		await prisma.authSession.deleteMany();
		await prisma.authRateBucket.deleteMany();
		await prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
		passwords.verify.mockClear();
	});
	afterAll(async () => {
		await app?.close();
		if (admin && user && superadmin)
			await prisma.user.deleteMany({ where: { id: { in: [admin.id, user.id, superadmin.id] } } });
		await prisma.authRateBucket.deleteMany();
		await prisma.$disconnect();
		if (oldSecret === undefined) delete process.env.JWT_REFRESH_SECRET;
		else process.env.JWT_REFRESH_SECRET = oldSecret;
	});
	it.each(['ADMIN', 'SUPERADMIN'])('allows %s login and admin check', async role => {
		const person = role === 'ADMIN' ? admin : superadmin;
		const r = await login(person).expect(201);
		expect(r.body.user.role).toBe(role);
		expect(r.body.refresh_token).toBeUndefined();
		expect(r.headers['set-cookie'][0]).toContain('HttpOnly');
		expect(JSON.stringify(r.body)).not.toContain('password');
		await request(app.getHttpServer()).get('/auth/admin/check').set(bearer(r.body.access_token)).expect(200);
	});
	it('rejects normal users, bad passwords, missing and tampered tokens', async () => {
		await login(user).expect(401);
		await request(app.getHttpServer())
			.post('/auth/admin/login')
			.send({ email: admin.email, password: 'wrong' })
			.expect(401);
		await request(app.getHttpServer()).get('/auth/admin/check').expect(401);
		await request(app.getHttpServer()).get('/auth/admin/check').set(bearer('bad.jwt.signature')).expect(401);
	});
	it('never logs the user record or password hash', async () => {
		const spy = vi.spyOn(console, 'log');
		try {
			await login(admin).expect(201);
			expect(JSON.stringify(spy.mock.calls)).not.toContain('test-password-hash');
			expect(JSON.stringify(spy.mock.calls)).not.toContain(admin.email);
		} finally {
			spy.mockRestore();
		}
	});
	it('stores only a refresh token hash and records an isolated realm', async () => {
		const r = await login(admin).expect(201);
		const session = await prisma.authSession.findFirstOrThrow({ where: { userId: admin.id } });
		expect(session.realm).toBe('admin');
		expect(session.refreshHash).toMatch(/^[a-f0-9]{64}$/);
		expect(cookie(r, 'admin_refresh_token')).not.toContain(session.refreshHash);
	});
	it('refreshes an admin session and revokes both old/new access and refresh tokens on logout', async () => {
		const r = await login(admin).expect(201);
		const c = cookie(r, 'admin_refresh_token');
		const refreshed = await request(app.getHttpServer()).post('/auth/admin/refresh').set('Cookie', c).expect(201);
		await request(app.getHttpServer()).post('/auth/admin/logout').set('Cookie', c).expect(201);
		for (const token of [r.body.access_token, refreshed.body.access_token])
			await request(app.getHttpServer()).get('/auth/admin/check').set(bearer(token)).expect(401);
		await request(app.getHttpServer()).post('/auth/admin/refresh').set('Cookie', c).expect(401);
		await request(app.getHttpServer()).post('/auth/admin/logout').set('Cookie', c).expect(201);
	});
	it('keeps user/admin sessions separate, including refresh and logout', async () => {
		const normal = await login(admin, false).expect(201);
		const privileged = await login(admin).expect(201);
		const normalRefresh = cookie(normal, 'refresh_token').split('=')[1];
		const adminRefresh = cookie(privileged, 'admin_refresh_token').split('=')[1];
		await request(app.getHttpServer()).get('/auth/admin/check').set(bearer(normal.body.access_token)).expect(401);
		await request(app.getHttpServer()).get('/auth/profile').set(bearer(privileged.body.access_token)).expect(401);
		await request(app.getHttpServer())
			.post('/auth/admin/refresh')
			.set('Cookie', `admin_refresh_token=${normalRefresh}`)
			.expect(401);
		await request(app.getHttpServer())
			.post('/auth/refresh')
			.set('Cookie', `refresh_token=${adminRefresh}`)
			.expect(401);
		await request(app.getHttpServer())
			.post('/auth/admin/logout')
			.set('Cookie', cookie(privileged, 'admin_refresh_token'))
			.expect(201);
		await request(app.getHttpServer()).get('/auth/profile').set(bearer(normal.body.access_token)).expect(200);
	});
	it('revokes a normal session and preserves another independently logged-in session', async () => {
		const a = await login(user, false).expect(201);
		const b = await login(user, false).expect(201);
		await request(app.getHttpServer()).post('/auth/logout').set('Cookie', cookie(a, 'refresh_token')).expect(201);
		await request(app.getHttpServer()).get('/auth/profile').set(bearer(a.body.access_token)).expect(401);
		await request(app.getHttpServer()).post('/auth/refresh').set('Cookie', cookie(a, 'refresh_token')).expect(401);
		await request(app.getHttpServer()).get('/auth/profile').set(bearer(b.body.access_token)).expect(200);
	});
	it('denies demoted admins immediately on check and refresh', async () => {
		const r = await login(admin).expect(201);
		await prisma.user.update({ where: { id: admin.id }, data: { role: 'USER' } });
		await request(app.getHttpServer()).get('/auth/admin/check').set(bearer(r.body.access_token)).expect(403);
		await request(app.getHttpServer())
			.post('/auth/admin/refresh')
			.set('Cookie', cookie(r, 'admin_refresh_token'))
			.expect(401);
	});
	it('denies expired sessions, wrong-purpose tokens and legacy tokens', async () => {
		const r = await login(admin).expect(201);
		const c = cookie(r, 'admin_refresh_token');
		const refresh = c.split('=')[1];
		await request(app.getHttpServer()).get('/auth/admin/check').set(bearer(refresh)).expect(401);
		await prisma.authSession.updateMany({ where: { userId: admin.id }, data: { expiresAt: new Date(0) } });
		await request(app.getHttpServer()).get('/auth/admin/check').set(bearer(r.body.access_token)).expect(401);
		await request(app.getHttpServer()).post('/auth/admin/refresh').set('Cookie', c).expect(401);
		await request(app.getHttpServer())
			.get('/auth/profile')
			.set(bearer(jwt.sign({ id: user.id, email: user.email })))
			.expect(401);
	});
	it('rejects injected roles and overlong passwords', async () => {
		await request(app.getHttpServer())
			.post('/auth/admin/login')
			.send({ email: user.email, password: 'correct-password', role: 'ADMIN' })
			.expect(400);
		await request(app.getHttpServer())
			.post('/auth/admin/login')
			.send({ email: user.email, password: 'x'.repeat(1025) })
			.expect(400);
	});
	it('returns 429 with Retry-After before more password checks', async () => {
		limits.ADMIN_LOGIN_ACCOUNT_LIMIT = '2';
		for (let i = 0; i < 2; i++)
			await request(app.getHttpServer())
				.post('/auth/admin/login')
				.send({ email: admin.email, password: 'wrong' })
				.expect(401);
		const r = await request(app.getHttpServer())
			.post('/auth/admin/login')
			.send({ email: admin.email, password: 'wrong' })
			.expect(429);
		expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
		expect(passwords.verify).toHaveBeenCalledTimes(2);
	});
	it('enforces an IP cap across different emails and ignores forged forwarding headers', async () => {
		limits.ADMIN_LOGIN_IP_LIMIT = '2';
		await login(admin).set('X-Forwarded-For', '1.1.1.1').expect(201);
		await login(superadmin).set('X-Forwarded-For', '2.2.2.2').expect(201);
		await login(user).set('X-Forwarded-For', '3.3.3.3').expect(429);
	});
	it('serializes simultaneous attempts across rate guard instances', async () => {
		limits.ADMIN_LOGIN_ACCOUNT_LIMIT = '1';
		const responses = await Promise.all([login(admin), login(admin), login(admin)]);
		expect(responses.map(r => r.status).sort()).toEqual([201, 429, 429]);
	});
	it('allows the admin origin for credentialed CORS and rejects foreign-origin logout', async () => {
		const r = await login(admin).set('Origin', 'http://localhost:3001').expect(201);
		expect(r.headers['access-control-allow-origin']).toBe('http://localhost:3001');
		await request(app.getHttpServer())
			.post('/auth/admin/logout')
			.set('Origin', 'https://untrusted.example')
			.set('Cookie', cookie(r, 'admin_refresh_token'))
			.expect(403);
		await request(app.getHttpServer()).get('/auth/admin/check').set(bearer(r.body.access_token)).expect(200);
	});
	it('does not fall back to the access signing secret for refresh tokens', async () => {
		delete process.env.JWT_REFRESH_SECRET;
		await expect(tokens.generateTokens({ id: user.id, email: user.email })).rejects.toThrow('JWT_REFRESH_SECRET');
		process.env.JWT_REFRESH_SECRET = 'isolated-auth-test-refresh';
	});
	it('rejects admin cookie operations initiated by the normal web app origin', async () => {
		const r = await login(admin).expect(201);
		const c = cookie(r, 'admin_refresh_token');
		await request(app.getHttpServer())
			.post('/auth/admin/refresh')
			.set('Origin', 'http://localhost:3000')
			.set('Cookie', c)
			.expect(403);
		await request(app.getHttpServer())
			.post('/auth/admin/logout')
			.set('Origin', 'http://localhost:3000')
			.set('Cookie', c)
			.expect(403);
		await request(app.getHttpServer())
			.post('/auth/admin/refresh')
			.set('Origin', 'http://localhost:3001')
			.set('Cookie', c)
			.expect(201);
	});
	it('enforces revocation through a separate token service instance', async () => {
		const pair = await tokens.generateTokens({ id: admin.id, email: admin.email }, 'admin');
		const other = new TokenService(jwt, prisma as any);
		await expect(other.verifyAccessToken(pair.access_token, 'admin')).resolves.toMatchObject({ id: admin.id });
		await other.revokeSession(pair.refresh_token, 'admin');
		await expect(tokens.verifyAccessToken(pair.access_token, 'admin')).rejects.toMatchObject({ status: 401 });
		await expect(tokens.verifyRefreshToken(pair.refresh_token, 'admin')).rejects.toMatchObject({ status: 401 });
	});
	it('production cookies are Secure and HttpOnly and production origins are explicit', async () => {
		const old = process.env.NODE_ENV;
		process.env.NODE_ENV = 'production';
		try {
			const r = await login(admin).expect(201);
			const header = r.headers['set-cookie'][0];
			expect(header).toContain('Secure');
			expect(header).toContain('HttpOnly');
			expect(header).toContain('SameSite=None');
			expect(
				authAllowedOrigins(
					{
						NODE_ENV: 'production',
						REQUEST_ORIGIN_PORT: 'https://app.example',
						ADMIN_ORIGIN: 'https://admin.example'
					},
					'admin'
				)
			).toEqual(['https://admin.example']);
		} finally {
			process.env.NODE_ENV = old;
		}
	});
	it('origin configuration rejects URLs with paths or credentials', () => {
		expect(() => authAllowedOrigins({ ADMIN_ORIGIN: 'https://example.com/path' })).toThrow();
		expect(() => authAllowedOrigins({ ADMIN_ORIGIN: 'https://user:password@example.com' })).toThrow();
	});
});
