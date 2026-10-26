import 'reflect-metadata';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { ConfigService } from '@nestjs/config';
import { CreditsService } from './credits.service.js';
import { PaymentsService } from './payments.service.js';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { PrismaService } from '../prisma/prisma.service.js';
import { TokenService } from '../auth/services/token.service.js';
import { AuthGuard, AdminAuthGuard } from '../auth/auth.guard.js';
import { SuperAdminGuard } from '../auth/services/superadmin.guard.js';
import { AuthOriginGuard } from '../auth/services/auth-origin.guard.js';
import { CreditsController, CreditQuoteDto } from './credits.controller.js';
import {
	PaymentsController,
	PaymentWebhookController,
	CreatePurchaseDto,
	VerifyPurchaseDto
} from './payments.controller.js';
import { AdminCreditsController, AdjustmentDto, PackDto } from '../admin/admin-credits.controller.js';
const url = process.env.AUDIO_FLOW_TEST_DATABASE_URL;
if (url && (new URL(url).hostname !== '127.0.0.1' || !new URL(url).pathname.endsWith('_test')))
	throw new Error('Isolated local *_test DB required');
describe.skipIf(!url)('Credit ledger and captured Razorpay payments', () => {
	const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) });
	const credits = new CreditsService(prisma as any);
	const settings = {
		RAZORPAY_ENABLED: 'true',
		RAZORPAY_KEY_ID: 'rzp_test_fixture',
		RAZORPAY_KEY_SECRET: 'fixture-secret',
		RAZORPAY_WEBHOOK_SECRET: 'fixture-webhook'
	};
	const payments = new PaymentsService(prisma as any, credits, new ConfigService(settings));
	const fakeFetch = vi.fn();
	const users: number[] = [];
	const packs: string[] = [];
	let userId: number,
		otherId: number,
		adminId: number,
		packId: string,
		userToken: string,
		otherToken: string,
		adminToken: string,
		ordinaryToken: string,
		app: INestApplication;
	let providerPayment: any;
	let orderCount = 0;
	const pricing = (values = {}) =>
		prisma.configuration.upsert({
			where: { key: 'credits_settings' },
			create: { key: 'credits_settings', value: values },
			update: { value: values }
		});
	const balance = async () => (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).creditBalance;
	const reserve = (ref: string, texts: string[] = [], kind: 'ANALYSIS' | 'AUDIO' = 'ANALYSIS') =>
		prisma.$transaction(tx => credits.reserve(tx, userId, ref, kind, texts, 123));
	const finish = (ref: string, success: boolean) => prisma.$transaction(tx => credits.finish(tx, ref, success));
	const signature = (order: string, payment = 'pay_fixture') =>
		createHmac('sha256', settings.RAZORPAY_KEY_SECRET)
			.update(order + '|' + payment)
			.digest('hex');
	async function order() {
		const value = await payments.create(userId, packId, randomUUID());
		providerPayment.order_id = (value as any).orderId;
		return value as { purchaseId: string; orderId: string };
	}
	async function webhook(event = 'payment.captured') {
		const raw = Buffer.from(JSON.stringify({ event, payload: { payment: { entity: { id: 'pay_fixture' } } } }));
		return payments.webhook(raw, createHmac('sha256', settings.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex'));
	}
	beforeAll(async () => {
		process.env.JWT_REFRESH_SECRET = 'credit-fixture-refresh';
		process.env.ADMIN_ORIGIN = 'http://localhost:3101';
		process.env.REQUEST_ORIGIN_PORT = 'http://localhost:3100';
		await prisma.$connect();
		const tokens = new TokenService(new JwtService({ secret: 'credit-access-fixture' }), prisma as any);
		for (const [index, role] of ['USER', 'USER', 'SUPERADMIN', 'ADMIN'].entries()) {
			const user = await prisma.user.create({
				data: {
					email: `credits-${randomUUID()}@example.test`,
					role: role as any,
					email_verified_at: new Date(),
					creditWelcomeGranted: true
				}
			});
			users.push(user.id);
			const token = (await tokens.generateTokens(user, index < 2 ? 'user' : 'admin')).access_token;
			if (index === 0) {
				userId = user.id;
				userToken = token;
			}
			if (index === 1) {
				otherId = user.id;
				otherToken = token;
			}
			if (index === 2) {
				adminId = user.id;
				adminToken = token;
			}
			if (index === 3) ordinaryToken = token;
		}
		for (const [cls, deps] of [
			[CreditsController, [CreditsService]],
			[PaymentsController, [PaymentsService]],
			[PaymentWebhookController, [PaymentsService]],
			[AdminCreditsController, [PrismaService, CreditsService]]
		] as any)
			Reflect.defineMetadata('design:paramtypes', deps, cls);
		for (const [cls, method, types] of [
			[CreditsController, 'quote', [Object, CreditQuoteDto]],
			[PaymentsController, 'create', [Object, CreatePurchaseDto]],
			[PaymentsController, 'verify', [Object, String, VerifyPurchaseDto]],
			[AdminCreditsController, 'adjust', [Number, Object, AdjustmentDto]],
			[AdminCreditsController, 'create', [PackDto]],
			[AdminCreditsController, 'update', [String, PackDto]]
		] as any)
			Reflect.defineMetadata('design:paramtypes', types, cls.prototype, method);
		const module = await Test.createTestingModule({
			controllers: [CreditsController, PaymentsController, PaymentWebhookController, AdminCreditsController],
			providers: [
				{ provide: PrismaService, useValue: prisma },
				{ provide: CreditsService, useValue: credits },
				{ provide: PaymentsService, useValue: payments },
				{ provide: TokenService, useValue: tokens },
				{ provide: AuthGuard, useValue: new AuthGuard(tokens) },
				{ provide: AdminAuthGuard, useValue: new AdminAuthGuard(tokens) },
				{ provide: SuperAdminGuard, useValue: new SuperAdminGuard(prisma as any) },
				AuthOriginGuard
			]
		}).compile();
		app = module.createNestApplication({ rawBody: true });
		app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
		await app.init();
	});
	beforeEach(async () => {
		await prisma.creditTransaction.deleteMany({ where: { userId: { in: users } } });
		await prisma.creditPurchase.deleteMany({ where: { userId: { in: users } } });
		await prisma.user.updateMany({
			where: { id: { in: users } },
			data: { creditBalance: 100, creditsBlocked: false, creditWelcomeGranted: true }
		});
		await pricing({ analysisCredits: 10, audioCreditsPer1000Characters: 10, welcomeCredits: 0 });
		const pack = await prisma.creditPack.create({ data: { name: 'Fixture pack', credits: 50, amountPaise: 500 } });
		packs.push(pack.id);
		packId = pack.id;
		providerPayment = {
			id: 'pay_fixture',
			order_id: '',
			amount: 500,
			currency: 'INR',
			status: 'captured',
			captured: true,
			amount_refunded: 0
		};
		fakeFetch.mockReset();
		orderCount = 0;
		fakeFetch.mockImplementation(async (url, options) => {
			if (url === 'https://api.razorpay.com/v1/orders') {
				const body = JSON.parse(options.body);
				return {
					ok: true,
					json: async () => ({
						id: 'order_fixture' + ++orderCount,
						amount: body.amount,
						currency: body.currency
					})
				};
			}
			if (String(url).endsWith('/payments'))
				return { ok: true, json: async () => ({ items: [providerPayment] }) };
			if (String(url).includes('/payments/')) return { ok: true, json: async () => providerPayment };
			throw new Error('Unexpected network request');
		});
		vi.stubGlobal('fetch', fakeFetch);
	});
	afterAll(async () => {
		vi.unstubAllGlobals();
		await app?.close();
		await prisma.creditTransaction.deleteMany({ where: { userId: { in: users } } });
		await prisma.creditPurchase.deleteMany({ where: { userId: { in: users } } });
		await prisma.creditPack.deleteMany({ where: { id: { in: packs } } });
		await prisma.audioStory.deleteMany({ where: { userId: { in: users } } });
		await prisma.user.deleteMany({ where: { id: { in: users } } });
		await pricing({});
		await prisma.$disconnect();
	});
	it('reserves once, captures once, and cannot refund a completed generation', async () => {
		await Promise.all([reserve('fixture:same'), reserve('fixture:same')]);
		expect(await balance()).toBe(90);
		await Promise.all([finish('fixture:same', true), finish('fixture:same', true)]);
		await finish('fixture:same', false);
		expect(await balance()).toBe(90);
		expect(await prisma.creditTransaction.count({ where: { userId } })).toBe(1);
	});
	it('releases failed/cancelled work once and prevents reservation reuse after refund', async () => {
		await reserve('fixture:cancel');
		await Promise.all([finish('fixture:cancel', false), finish('fixture:cancel', false)]);
		expect(await balance()).toBe(100);
		await expect(reserve('fixture:cancel')).rejects.toThrow('no longer available');
	});
	it('prevents negative balances across concurrent story submissions', async () => {
		await pricing({ analysisCredits: 80 });
		const result = await Promise.allSettled([reserve('fixture:a'), reserve('fixture:b')]);
		expect(result.filter(row => row.status === 'fulfilled')).toHaveLength(1);
		expect(await balance()).toBe(20);
	});
	it('rolls back every hold if a multi-scene reservation cannot be funded', async () => {
		await pricing({ audioCreditsPer1000Characters: 80 });
		await expect(
			prisma.$transaction(async tx => {
				await credits.reserve(tx, userId, 'fixture:1', 'AUDIO', ['a'.repeat(1000)], 1);
				await credits.reserve(tx, userId, 'fixture:2', 'AUDIO', ['b'.repeat(1000)], 1);
			})
		).rejects.toThrow('Not enough');
		expect(await balance()).toBe(100);
		expect(await prisma.creditTransaction.count({ where: { userId } })).toBe(0);
	});
	it('keeps reservation prices fixed and counts Unicode code points', async () => {
		await reserve('fixture:price');
		await pricing({ analysisCredits: 90, audioCreditsPer1000Characters: 1000 });
		await finish('fixture:price', true);
		expect(await balance()).toBe(90);
		expect(credits.cost('AUDIO', ['😀a'], await credits.pricing())).toBe(2);
	});
	it('grants welcome credits once only to verified eligible users', async () => {
		await pricing({ welcomeCredits: 25 });
		await prisma.user.update({ where: { id: userId }, data: { creditWelcomeGranted: false } });
		await Promise.all([credits.wallet(userId), credits.wallet(userId)]);
		expect(await balance()).toBe(125);
		expect(await prisma.creditTransaction.count({ where: { reference: 'welcome:' + userId } })).toBe(1);
	});
	it('audits idempotent admin adjustments and refuses overspending removal', async () => {
		const ref = 'admin:test';
		await prisma.$transaction(tx => credits.grant(tx, userId, 20, ref, 'ADMIN', 'Support bonus', adminId));
		await prisma.$transaction(tx => credits.grant(tx, userId, 20, ref, 'ADMIN', 'Support bonus', adminId));
		expect(await balance()).toBe(120);
		await expect(
			prisma.$transaction(tx => credits.grant(tx, userId, -121, 'admin:bad', 'ADMIN', 'Bad removal', adminId))
		).rejects.toThrow('out of range');
	});
	it('creates one server-priced order per idempotency key and snapshots its pack', async () => {
		const key = randomUUID();
		const first = await payments.create(userId, packId, key);
		const second = await payments.create(userId, packId, key);
		expect(first).toEqual(second);
		expect(fakeFetch).toHaveBeenCalledTimes(1);
		await prisma.creditPack.update({ where: { id: packId }, data: { credits: 500, amountPaise: 5000 } });
		providerPayment.order_id = (first as any).orderId;
		await payments.verify(userId, (first as any).purchaseId, 'pay_fixture', signature((first as any).orderId));
		expect(await balance()).toBe(150);
	});
	it('credits a captured payment once across concurrent callback/webhook retries', async () => {
		const value = await order();
		await Promise.all([
			payments.verify(userId, value.purchaseId, 'pay_fixture', signature(value.orderId)),
			webhook(),
			webhook()
		]);
		expect(await balance()).toBe(150);
		expect(await prisma.creditTransaction.count({ where: { reference: 'purchase:' + value.purchaseId } })).toBe(1);
	});
	it('does not grant credits for authorized, failed or cancelled checkout', async () => {
		const value = await order();
		providerPayment.status = 'authorized';
		providerPayment.captured = false;
		expect(await payments.verify(userId, value.purchaseId, 'pay_fixture', signature(value.orderId))).toEqual({
			status: 'PENDING'
		});
		expect(await balance()).toBe(100);
	});
	it('rejects signatures, amount/currency mismatch and payment/order mismatch', async () => {
		const value = await order();
		await expect(payments.verify(userId, value.purchaseId, 'pay_fixture', '0'.repeat(64))).rejects.toThrow(
			'signature'
		);
		providerPayment.amount = 1;
		await expect(
			payments.verify(userId, value.purchaseId, 'pay_fixture', signature(value.orderId))
		).rejects.toThrow('amount');
		providerPayment.amount = 500;
		providerPayment.currency = 'USD';
		await expect(
			payments.verify(userId, value.purchaseId, 'pay_fixture', signature(value.orderId))
		).rejects.toThrow('currency');
		providerPayment.currency = 'INR';
		providerPayment.order_id = 'order_other';
		await expect(
			payments.verify(userId, value.purchaseId, 'pay_fixture', signature(value.orderId))
		).rejects.toThrow('another order');
		expect(await balance()).toBe(100);
	});
	it('enforces purchase ownership and webhook raw-body authenticity', async () => {
		const value = await order();
		await expect(
			payments.verify(otherId, value.purchaseId, 'pay_fixture', signature(value.orderId))
		).rejects.toThrow('not found');
		await expect(payments.webhook(Buffer.from('{}'), '0'.repeat(64))).rejects.toThrow('signature');
		expect(fakeFetch).toHaveBeenCalledTimes(1);
	});
	it('recovers payment status after a lost browser callback', async () => {
		const value = await order();
		expect(await payments.refresh(userId, value.purchaseId)).toEqual({ status: 'PAID' });
		expect(await balance()).toBe(150);
	});
	it('blocks refunded/disputed wallets and does not recredit or unblock on old capture events', async () => {
		const value = await order();
		await webhook();
		providerPayment.amount_refunded = 100;
		await webhook('refund.processed');
		expect((await credits.wallet(userId)).blocked).toBe(true);
		await expect(reserve('fixture:blocked')).rejects.toThrow('review');
		providerPayment.amount_refunded = 0;
		await webhook();
		expect(await balance()).toBe(150);
		expect((await credits.wallet(userId)).blocked).toBe(true);
	});
	it('requires current Super Admin/origin and isolates user/admin token realms', async () => {
		await request(app.getHttpServer()).get('/credits/wallet').expect(401);
		await request(app.getHttpServer())
			.get('/credits/wallet')
			.set('Authorization', 'Bearer ' + adminToken)
			.expect(401);
		await request(app.getHttpServer())
			.get('/admin/credits/users')
			.set('Authorization', 'Bearer ' + ordinaryToken)
			.expect(403);
		await request(app.getHttpServer())
			.post('/admin/credits/users/' + userId + '/adjust')
			.set('Authorization', 'Bearer ' + adminToken)
			.set('Origin', 'https://bad.example')
			.send({ amount: 10, reason: 'Fixture grant', requestId: randomUUID() })
			.expect(403);
	});
	it('validates adjustment input, preserves duplicate idempotency, and allows audited review completion', async () => {
		const body = { amount: 5, reason: 'Fixture bonus', requestId: randomUUID() };
		await request(app.getHttpServer())
			.post('/admin/credits/users/' + userId + '/adjust')
			.set('Authorization', 'Bearer ' + adminToken)
			.send({ ...body, amount: 1.2 })
			.expect(400);
		for (let i = 0; i < 2; i++)
			await request(app.getHttpServer())
				.post('/admin/credits/users/' + userId + '/adjust')
				.set('Authorization', 'Bearer ' + adminToken)
				.send(body)
				.expect(201);
		expect(await balance()).toBe(105);
		const value = await order();
		await webhook('refund.processed');
		await request(app.getHttpServer())
			.post('/admin/credits/users/' + userId + '/adjust')
			.set('Authorization', 'Bearer ' + adminToken)
			.send({ amount: 0, reason: 'Refund reviewed', unblock: true, requestId: randomUUID() })
			.expect(201);
		await webhook('refund.processed');
		expect((await credits.wallet(userId)).blocked).toBe(false);
	});
	it('rejects another user story quote and history cursor', async () => {
		const story = await prisma.audioStory.create({ data: { userId, title: 'Credit fixture', content: 'Test' } });
		await request(app.getHttpServer())
			.post('/credits/quote')
			.set('Authorization', 'Bearer ' + otherToken)
			.send({ kind: 'ANALYSIS', storyId: story.id })
			.expect(404);
		await reserve('fixture:private');
		const entry = await prisma.creditTransaction.findFirstOrThrow({ where: { userId } });
		await expect(credits.history(otherId, entry.id)).rejects.toThrow('cursor');
	});
});
