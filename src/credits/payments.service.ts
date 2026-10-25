import {
	BadRequestException,
	ConflictException,
	HttpException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreditsService } from './credits.service.js';
@Injectable()
export class PaymentsService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly credits: CreditsService,
		private readonly config: ConfigService
	) {}
	private keys() {
		const keyId = this.config.get<string>('RAZORPAY_KEY_ID')?.trim();
		const secret = this.config.get<string>('RAZORPAY_KEY_SECRET')?.trim();
		if (
			this.config.get<string>('RAZORPAY_ENABLED') !== 'true' ||
			!keyId ||
			!secret ||
			!this.config.get<string>('RAZORPAY_WEBHOOK_SECRET')?.trim()
		)
			throw new ServiceUnavailableException('Payments are not configured. Contact support.');
		return { keyId, secret };
	}
	info() {
		try {
			return { enabled: true, mode: this.keys().keyId.startsWith('rzp_test_') ? 'test' : 'live' };
		} catch {
			return { enabled: false, mode: 'disabled' };
		}
	}
	private async api(path: string, body?: unknown): Promise<any> {
		const { keyId, secret } = this.keys();
		try {
			const response = await fetch('https://api.razorpay.com/v1/' + path, {
				method: body ? 'POST' : 'GET',
				headers: {
					Authorization: 'Basic ' + Buffer.from(keyId + ':' + secret).toString('base64'),
					'Content-Type': 'application/json'
				},
				...(body ? { body: JSON.stringify(body) } : {}),
				signal: AbortSignal.timeout(20000)
			});
			if (!response.ok) throw new Error('Payment provider rejected the request');
			return await response.json();
		} catch {
			throw new ServiceUnavailableException(
				'Payment verification is temporarily unavailable. Refresh payment status later; do not pay again.'
			);
		}
	}
	private signature(value: string, signature: string, secret: string) {
		if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
		const expected = createHmac('sha256', secret).update(value).digest();
		return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
	}
	async create(userId: number, packId: string, requestId: string) {
		const { keyId } = this.keys();
		const purchase = await this.prisma.$transaction(async tx => {
			await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
			const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
			if (user.creditsBlocked) throw new BadRequestException('Wallet requires payment review. Contact support.');
			const existing = await tx.creditPurchase.findUnique({ where: { userId_requestId: { userId, requestId } } });
			if (existing) {
				if (existing.packId !== packId) throw new ConflictException('Request ID belongs to another pack');
				return existing;
			}
			if (
				(await tx.creditPurchase.count({
					where: { userId, createdAt: { gt: new Date(Date.now() - 900000) } }
				})) >= 10
			)
				throw new HttpException('Too many checkout attempts. Try later.', 429);
			const pack = await tx.creditPack.findFirst({ where: { id: packId, active: true } });
			if (!pack) throw new NotFoundException('Credit pack unavailable');
			return tx.creditPurchase.create({
				data: {
					userId,
					requestId,
					packId,
					packName: pack.name,
					credits: pack.credits,
					amountPaise: pack.amountPaise,
					providerKeyId: keyId
				}
			});
		});
		if (purchase.status === 'PAID') return { purchaseId: purchase.id, paid: true };
		if (purchase.status !== 'CREATING' && !purchase.orderId)
			throw new BadRequestException('Checkout did not complete. Start a new checkout.');
		if (purchase.orderId) return this.checkout(purchase);
		// Only the transaction that created this request may send the external create call.
		const claimed = await this.prisma.creditPurchase.updateMany({
			where: { id: purchase.id, status: 'CREATING' },
			data: { status: 'REQUESTING' }
		});
		if (!claimed.count) throw new ConflictException('Checkout is being prepared. Refresh payment history shortly.');
		try {
			const order = await this.api('orders', {
				amount: purchase.amountPaise,
				currency: 'INR',
				receipt: purchase.id,
				notes: { purchaseId: purchase.id }
			});
			if (
				!/^order_[a-zA-Z0-9]+$/.test(order.id) ||
				order.amount !== purchase.amountPaise ||
				order.currency !== 'INR'
			)
				throw new Error('Invalid provider order');
			return this.checkout(
				await this.prisma.creditPurchase.update({
					where: { id: purchase.id },
					data: { orderId: order.id, status: 'CREATED' }
				})
			);
		} catch {
			await this.prisma.creditPurchase.updateMany({
				where: { id: purchase.id, status: 'REQUESTING' },
				data: { status: 'FAILED' }
			});
			throw new ServiceUnavailableException(
				'Checkout could not be created. No credits were added. Try a new checkout later.'
			);
		}
	}
	private checkout(purchase: {
		id: string;
		providerKeyId: string;
		orderId: string | null;
		amountPaise: number;
		currency: string;
		packName: string;
	}) {
		return {
			purchaseId: purchase.id,
			keyId: purchase.providerKeyId,
			orderId: purchase.orderId,
			amount: purchase.amountPaise,
			currency: purchase.currency,
			name: purchase.packName
		};
	}
	async verify(userId: number, purchaseId: string, paymentId: string, signature: string) {
		const purchase = await this.prisma.creditPurchase.findFirst({ where: { id: purchaseId, userId } });
		if (!purchase?.orderId) throw new NotFoundException('Purchase not found');
		if (!this.signature(purchase.orderId + '|' + paymentId, signature, this.keys().secret))
			throw new BadRequestException('Invalid payment signature');
		const payment = await this.api('payments/' + paymentId);
		if (payment.order_id !== purchase.orderId) throw new BadRequestException('Payment belongs to another order');
		return this.confirm(payment);
	}
	async refresh(userId: number, purchaseId: string) {
		const purchase = await this.prisma.creditPurchase.findFirst({ where: { id: purchaseId, userId } });
		if (!purchase?.orderId) return { status: purchase?.status ?? 'NOT_FOUND' };
		const payments = await this.api('orders/' + purchase.orderId + '/payments');
		const payment = payments.items?.find((item: any) => item.status === 'captured' || item.status === 'refunded');
		if (payment && payment.order_id !== purchase.orderId)
			throw new BadRequestException('Payment belongs to another order');
		return payment ? this.confirm(payment) : { status: purchase.status };
	}
	private async confirm(payment: any, review = false) {
		if (!payment?.order_id || !payment.id) throw new BadRequestException('Invalid payment');
		return this.prisma.$transaction(async tx => {
			await tx.$queryRaw`SELECT id FROM "CreditPurchase" WHERE "orderId" = ${payment.order_id} FOR UPDATE`;
			const purchase = await tx.creditPurchase.findUnique({ where: { orderId: payment.order_id } });
			if (!purchase) return { status: 'IGNORED' };
			if (payment.amount !== purchase.amountPaise || payment.currency !== 'INR')
				throw new BadRequestException('Payment amount or currency mismatch');
			if (purchase.status === 'REVIEWED' || (review && purchase.status === 'REVIEW'))
				return { status: purchase.status };
			if (review || payment.amount_refunded > 0 || payment.status === 'refunded') {
				await tx.user.update({ where: { id: purchase.userId }, data: { creditsBlocked: true } });
				await tx.creditPurchase.update({
					where: { id: purchase.id },
					data: { status: 'REVIEW', paymentId: payment.id }
				});
				return { status: 'REVIEW' };
			}
			if (purchase.status === 'PAID' || purchase.status === 'REVIEW') return { status: purchase.status };
			if (payment.status !== 'captured' || payment.captured !== true) return { status: 'PENDING' };
			await this.credits.grant(
				tx,
				purchase.userId,
				purchase.credits,
				'purchase:' + purchase.id,
				'PURCHASE',
				purchase.packName
			);
			await tx.creditPurchase.update({
				where: { id: purchase.id },
				data: { status: 'PAID', paymentId: payment.id }
			});
			return { status: 'PAID' };
		});
	}
	async webhook(raw: Buffer | undefined, signature: string) {
		const secret = this.config.get<string>('RAZORPAY_WEBHOOK_SECRET');
		if (!secret || !raw || !this.signature(raw.toString('utf8'), signature, secret))
			throw new BadRequestException('Invalid webhook signature');
		const event = JSON.parse(raw.toString('utf8'));
		const supported = ['payment.captured', 'order.paid', 'refund.processed', 'payment.dispute.created'];
		if (!supported.includes(event.event)) return { received: true };
		const paymentId =
			event.payload?.payment?.entity?.id ??
			event.payload?.refund?.entity?.payment_id ??
			event.payload?.dispute?.entity?.payment_id;
		if (!/^pay_[a-zA-Z0-9]+$/.test(paymentId ?? '')) throw new BadRequestException('Invalid payment ID');
		await this.confirm(
			await this.api('payments/' + paymentId),
			['refund.processed', 'payment.dispute.created'].includes(event.event)
		);
		return { received: true };
	}
}
