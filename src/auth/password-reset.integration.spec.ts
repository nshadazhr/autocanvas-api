import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { PasswordHasher } from '@nestjs/authentication';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../prisma/prisma.service.js';
import { PasswordResetController } from './password-reset.controller.js';
import { PasswordResetService, RESET_REQUEST_MESSAGE } from './services/password-reset.service.js';
import { PasswordResetRateGuard } from './services/password-reset-rate.guard.js';
import { AuthOriginGuard } from './services/auth-origin.guard.js';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/password-reset.dto.js';
import { TokenService } from './services/token.service.js';
import { AuthService } from './auth.service.js';
import { UserService } from '../user/user.service.js';
import { EmailService } from './services/email.service.js';

const databaseUrl = process.env.AUDIO_FLOW_TEST_DATABASE_URL;
if (databaseUrl) {
	const url = new URL(databaseUrl);
	if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.endsWith('_test'))
		throw Error('Disposable local test database required');
}
describe.skipIf(!databaseUrl)('password reset with PostgreSQL and HTTP', () => {
	const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl! }) });
	const passwords = new PasswordHasher({ logN: 14 });
	const mail = { sendPasswordReset: vi.fn(async (_email: string, _link: string) => {}) };
	const service = new PasswordResetService(prisma as any, mail as any, passwords);
	const jwt = new JwtService({ secret: 'fixture-reset-access' });
	const tokens = new TokenService(jwt, prisma as any);
	const auth = new AuthService(
		{} as any,
		new UserService(prisma as any),
		passwords,
		tokens,
		{} as any,
		{} as any,
		{} as any
	);
	let app: INestApplication;
	let user: any, google: any, unverified: any;
	const oldEnv = {
		RESEND_API_KEY: process.env.RESEND_API_KEY,
		JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
		REQUEST_ORIGIN_PORT: process.env.REQUEST_ORIGIN_PORT
	};
	const oldPassword = 'Old-fixture123!';
	const newPassword = 'New-fixture456!';
	const forgot = (email: string) =>
		request(app.getHttpServer()).post('/auth/forgot-password').send({ email });
	const reset = (token: string, password = newPassword) =>
		request(app.getHttpServer()).post('/auth/reset-password').send({ token, password });
	const lastToken = () =>
		new URLSearchParams(new URL(mail.sendPasswordReset.mock.calls.at(-1)![1]).hash.slice(1)).get(
			'token'
		)!;
	beforeAll(async () => {
		process.env.RESEND_API_KEY = 'fixture-not-a-live-key';
		process.env.JWT_REFRESH_SECRET = 'fixture-reset-refresh';
		process.env.REQUEST_ORIGIN_PORT = 'http://localhost:3000';
		await prisma.$connect();
		const hash = await passwords.hash(oldPassword);
		user = await prisma.user.create({
			data: {
				email: `reset-${randomUUID()}@example.test`,
				password: hash,
				email_verified_at: new Date()
			}
		});
		google = await prisma.user.create({
			data: { email: `google-${randomUUID()}@example.test`, email_verified_at: new Date() }
		});
		unverified = await prisma.user.create({
			data: { email: `unverified-${randomUUID()}@example.test`, password: hash }
		});
		Reflect.defineMetadata('design:paramtypes', [PasswordResetService], PasswordResetController);
		Reflect.defineMetadata(
			'design:paramtypes',
			[ForgotPasswordDto],
			PasswordResetController.prototype,
			'request'
		);
		Reflect.defineMetadata(
			'design:paramtypes',
			[ResetPasswordDto, Object],
			PasswordResetController.prototype,
			'reset'
		);
		const module = await Test.createTestingModule({
			controllers: [PasswordResetController],
			providers: [
				{ provide: PasswordResetService, useValue: service },
				{ provide: PrismaService, useValue: prisma },
				{ provide: PasswordResetRateGuard, useValue: new PasswordResetRateGuard(prisma as any) },
				{ provide: AuthOriginGuard, useValue: new AuthOriginGuard() }
			]
		}).compile();
		app = module.createNestApplication();
		app.useGlobalPipes(
			new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })
		);
		await app.init();
	});
	beforeEach(async () => {
		await prisma.authRateBucket.deleteMany({ where: { key: { startsWith: 'reset-' } } });
		await prisma.passwordReset.deleteMany({
			where: { userId: { in: [user.id, google.id, unverified.id] } }
		});
		await prisma.user.update({
			where: { id: user.id },
			data: { password: await passwords.hash(oldPassword) }
		});
		mail.sendPasswordReset.mockReset();
		mail.sendPasswordReset.mockResolvedValue(undefined);
	});
	afterAll(async () => {
		await app?.close();
		if (user)
			await prisma.user.deleteMany({ where: { id: { in: [user.id, google.id, unverified.id] } } });
		await prisma.authRateBucket.deleteMany({ where: { key: { startsWith: 'reset-' } } });
		await prisma.$disconnect();
		for (const [key, value] of Object.entries(oldEnv))
			value === undefined ? delete process.env[key] : (process.env[key] = value);
	});

	it('returns the same response for known, unknown, Google-only and unverified accounts; stores only token hash', async () => {
		const known = await forgot(` ${user.email.toUpperCase()} `);
		expect(known.status).toBe(200);
		for (const email of [`unknown-${randomUUID()}@example.test`, google.email, unverified.email])
			expect((await forgot(email)).body).toEqual(known.body);
		expect(known.body).toEqual({ message: RESET_REQUEST_MESSAGE });
		expect(mail.sendPasswordReset).toHaveBeenCalledTimes(1);
		const token = lastToken();
		const link = new URL(mail.sendPasswordReset.mock.calls[0][1]);
		expect(link.origin).toBe('http://localhost:3000');
		expect(link.pathname).toBe('/reset-password');
		expect(link.search).toBe('');
		const row = await prisma.passwordReset.findUniqueOrThrow({ where: { userId: user.id } });
		expect(row.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
		expect(row.tokenHash).not.toBe(token);
		expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
		expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(30 * 60_000);
	});

	it('changes the real password, rejects the old login and revokes user/admin access and refresh sessions', async () => {
		const priorUser = await tokens.generateTokens(user);
		const priorAdmin = await tokens.generateTokens(user, 'admin');
		await forgot(user.email);
		const token = lastToken();
		const response = await reset(token);
		expect(response.status).toBe(200);
		expect([response.headers['set-cookie']].flat().join(' ')).toContain('refresh_token=;');
		expect(response.headers['cache-control']).toBe('no-store');
		await expect(auth.login({ email: user.email, password: oldPassword })).rejects.toThrow(
			'Invalid email or password'
		);
		expect((await auth.login({ email: user.email, password: newPassword })).user.id).toBe(user.id);
		await expect(tokens.verifyAccessToken(priorUser.access_token)).rejects.toThrow();
		await expect(tokens.verifyRefreshToken(priorUser.refresh_token)).rejects.toThrow();
		await expect(tokens.verifyAccessToken(priorAdmin.access_token, 'admin')).rejects.toThrow();
		await expect(tokens.verifyRefreshToken(priorAdmin.refresh_token, 'admin')).rejects.toThrow();
		expect((await reset(token)).body.code).toBe('RESET_TOKEN_INVALID');
	});

	it('rejects expired/unknown/replaced tokens and permits only one concurrent consumption', async () => {
		await forgot(user.email);
		const first = lastToken();
		await forgot(user.email);
		const second = lastToken();
		expect((await reset(first)).status).toBe(400);
		await prisma.passwordReset.update({
			where: { userId: user.id },
			data: { expiresAt: new Date(Date.now() - 1000) }
		});
		expect((await reset(second)).body.code).toBe('RESET_TOKEN_INVALID');
		expect((await reset('0'.repeat(64))).status).toBe(400);
		await forgot(user.email);
		const fresh = lastToken();
		const results = await Promise.all([reset(fresh), reset(fresh)]);
		expect(results.map(r => r.status).sort()).toEqual([200, 400]);
	});

	it('does not create a reset token or send email without a production user origin', async () => {
		const oldNodeEnv = process.env.NODE_ENV;
		const oldOrigin = process.env.REQUEST_ORIGIN_PORT;
		process.env.NODE_ENV = 'production';
		delete process.env.REQUEST_ORIGIN_PORT;
		try {
			await expect(service.request(user.email)).rejects.toMatchObject({ status: 500 });
			expect(await prisma.passwordReset.count({ where: { userId: user.id } })).toBe(0);
			expect(mail.sendPasswordReset).not.toHaveBeenCalled();
		} finally {
			if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = oldNodeEnv;
			if (oldOrigin === undefined) delete process.env.REQUEST_ORIGIN_PORT;
			else process.env.REQUEST_ORIGIN_PORT = oldOrigin;
		}
	});
	it('rejects weak passwords, malformed tokens, untrusted origins and throttles repeated requests', async () => {
		expect((await forgot('invalid-email')).status).toBe(400);
		expect((await reset('invalid')).status).toBe(400);
		await forgot(user.email);
		const token = lastToken();
		expect((await reset(token, 'weakpass')).status).toBe(400);
		expect(
			(
				await request(app.getHttpServer())
					.post('/auth/forgot-password')
					.set('Origin', 'https://untrusted.example')
					.send({ email: user.email })
			).status
		).toBe(403);
		await forgot(user.email);
		await forgot(user.email);
		const limited = await forgot(user.email);
		expect(limited.status).toBe(429);
		expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
	});

	it('rolls back password and token consumption if session revocation fails', async () => {
		await forgot(user.email);
		const token = lastToken();
		const prismaWithFailure = {
			passwordReset: prisma.passwordReset,
			$transaction: (callback: any) =>
				prisma.$transaction(tx =>
					callback({
						passwordReset: tx.passwordReset,
						user: tx.user,
						authSession: {
							updateMany: async () => {
								throw Error('fixture revoke failure');
							}
						}
					})
				)
		};
		const failing = new PasswordResetService(prismaWithFailure as any, mail as any, passwords);
		await expect(failing.reset(token, newPassword)).rejects.toThrow('fixture revoke failure');
		expect(await prisma.passwordReset.findUnique({ where: { userId: user.id } })).not.toBeNull();
		expect(
			await passwords.verify(
				oldPassword,
				(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).password!
			)
		).toBe(true);
	});

	it('email failure does not expose eligibility or leave a usable token; missing sender config is explicit', async () => {
		mail.sendPasswordReset.mockRejectedValueOnce(Error('fixture email failure'));
		expect((await forgot(user.email)).body).toEqual({ message: RESET_REQUEST_MESSAGE });
		expect(await prisma.passwordReset.findUnique({ where: { userId: user.id } })).toBeNull();
		delete process.env.RESEND_API_KEY;
		expect((await forgot(user.email)).status).toBe(500);
		process.env.RESEND_API_KEY = 'fixture-not-a-live-key';
	});

	it('email adapter sends a reset-specific email without logging raw token errors', async () => {
		const send = vi.fn(async (_payload: any) => ({ data: { id: 'fixture-message' }, error: null }));
		const email = new EmailService({ emails: { send } } as any);
		await email.sendPasswordReset(
			'fixture@example.test',
			'https://example.test/reset-password#token=fixture'
		);
		expect(send.mock.calls[0][0].subject).toBe('Reset your AutoCanvas password');
		expect(send.mock.calls[0][0].text).toContain('30 minutes');
	});
});
