import { StoryAnalysisSchema } from '../ai/schemas/story-analysis.schema.js';
import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { readConfiguration } from '../settings/configuration-store.js';
import { runtimeDefaults } from '../settings/runtime-settings.js';
type Tx = Prisma.TransactionClient;
export type CreditKind = 'ANALYSIS' | 'AUDIO' | 'SINGLE_AUDIO';
const MAX_BALANCE = 2_000_000_000;
@Injectable()
export class CreditsService {
	constructor(private readonly prisma: PrismaService) {}
	async pricing(tx: Tx = this.prisma) {
		const saved = await readConfiguration(tx, 'credits_settings');
		return Object.fromEntries(
			Object.entries(runtimeDefaults.pricing).map(([key, fallback]) => {
				const value = saved[key];
				return [
					key,
					typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000
						? value
						: fallback
				];
			})
		) as Record<keyof typeof runtimeDefaults.pricing, number>;
	}
	cost(kind: CreditKind, texts: string[], pricing: Awaited<ReturnType<CreditsService['pricing']>>) {
		const cost =
			kind === 'ANALYSIS'
				? pricing.analysisCredits
				: texts.reduce(
						(sum, text) =>
							sum +
							Math.ceil((Array.from(text.trim()).length * pricing.audioCreditsPer1000Characters) / 1000),
						0
					);
		if (!Number.isSafeInteger(cost) || cost < 0 || cost > MAX_BALANCE)
			throw new BadRequestException('Credit cost is out of range');
		return cost;
	}
	private async lock(tx: Tx, userId: number) {
		await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
		const user = await tx.user.findUnique({ where: { id: userId } });
		if (!user) throw new NotFoundException('User not found');
		return user;
	}
	async welcome(tx: Tx, userId: number) {
		const user = await this.lock(tx, userId);
		if (user.creditWelcomeGranted || !user.email_verified_at) return;
		const { welcomeCredits } = await this.pricing(tx);
		if (user.creditBalance + welcomeCredits > MAX_BALANCE)
			throw new BadRequestException('Welcome grant would put balance out of range');
		await tx.user.update({
			where: { id: userId },
			data: { creditWelcomeGranted: true, creditBalance: { increment: welcomeCredits } }
		});
		if (welcomeCredits)
			await tx.creditTransaction.create({
				data: {
					userId,
					reference: `welcome:${userId}`,
					amount: welcomeCredits,
					type: 'WELCOME',
					status: 'COMPLETED',
					reason: 'Verified-account welcome credits'
				}
			});
	}
	async reserve(tx: Tx, userId: number, reference: string, kind: CreditKind, texts: string[], storyId: number) {
		await this.welcome(tx, userId);
		const user = await this.lock(tx, userId);
		if (user.creditsBlocked)
			throw new HttpException(
				{ code: 'CREDITS_BLOCKED', message: 'Your credit wallet requires a payment review. Contact support.' },
				403
			);
		const existing = await tx.creditTransaction.findUnique({ where: { reference } });
		if (existing) {
			if (existing.userId !== userId || existing.status === 'REFUNDED')
				throw new ConflictException('Credit reservation is no longer available');
			return existing;
		}
		const amount = this.cost(kind, texts, await this.pricing(tx));
		if (user.creditBalance < amount)
			throw new HttpException(
				{
					code: 'INSUFFICIENT_CREDITS',
					message: 'Not enough credits. Add credits before generating.',
					required: amount,
					available: user.creditBalance
				},
				402
			);
		await tx.user.update({ where: { id: userId }, data: { creditBalance: { decrement: amount } } });
		return tx.creditTransaction.create({
			data: {
				reference,
				userId,
				amount: -amount,
				type: kind,
				status: 'RESERVED',
				reason: `${kind} generation`,
				storyId
			}
		});
	}
	/** Call inside the same transaction that saves success/failure/cancellation. */
	async finish(tx: Tx, reference: string, success: boolean) {
		const entry = await tx.creditTransaction.findUnique({ where: { reference } });
		if (!entry) return; // Work already running before billing was deployed is not retroactively charged.
		await this.lock(tx, entry.userId);
		const changed = await tx.creditTransaction.updateMany({
			where: { id: entry.id, status: 'RESERVED' },
			data: { status: success ? 'COMPLETED' : 'REFUNDED' }
		});
		if (changed.count && !success)
			await tx.user.update({
				where: { id: entry.userId },
				data: { creditBalance: { increment: -entry.amount } }
			});
	}
	async grant(
		tx: Tx,
		userId: number,
		amount: number,
		reference: string,
		type: string,
		reason: string,
		actorId?: number
	) {
		const user = await this.lock(tx, userId);
		const existing = await tx.creditTransaction.findUnique({ where: { reference } });
		if (existing) {
			if (existing.userId !== userId || existing.amount !== amount || existing.reason !== reason)
				throw new ConflictException('This request ID was already used for another adjustment');
			return { entry: existing, created: false };
		}
		const held = await tx.creditTransaction.aggregate({
			where: { userId, status: 'RESERVED' },
			_sum: { amount: true }
		});
		if (
			!Number.isSafeInteger(amount) ||
			user.creditBalance + amount < 0 ||
			user.creditBalance + amount - (held._sum.amount ?? 0) > MAX_BALANCE
		)
			throw new BadRequestException('Adjustment would put balance out of range');
		await tx.user.update({ where: { id: userId }, data: { creditBalance: { increment: amount } } });
		return {
			entry: await tx.creditTransaction.create({
				data: { userId, reference, amount, type, status: 'COMPLETED', reason, actorId }
			}),
			created: true
		};
	}
	async wallet(userId: number) {
		await this.prisma.$transaction(tx => this.welcome(tx, userId));
		const [user, held, pricing, transactions, purchases, packs] = await Promise.all([
			this.prisma.user.findUniqueOrThrow({
				where: { id: userId },
				select: { creditBalance: true, creditsBlocked: true }
			}),
			this.prisma.creditTransaction.aggregate({ where: { userId, status: 'RESERVED' }, _sum: { amount: true } }),
			this.pricing(),
			this.history(userId),
			this.prisma.creditPurchase.findMany({
				where: { userId },
				orderBy: { createdAt: 'desc' },
				take: 10,
				select: { id: true, packName: true, credits: true, amountPaise: true, status: true, createdAt: true }
			}),
			this.prisma.creditPack.findMany({
				where: { active: true },
				orderBy: { amountPaise: 'asc' },
				select: { id: true, name: true, credits: true, amountPaise: true }
			})
		]);
		return {
			balance: user.creditBalance,
			reserved: -(held._sum.amount ?? 0),
			blocked: user.creditsBlocked,
			pricing,
			transactions,
			purchases,
			packs
		};
	}
	async history(userId: number, cursor?: string) {
		if (cursor && !(await this.prisma.creditTransaction.findFirst({ where: { id: cursor, userId } })))
			throw new BadRequestException('Invalid history cursor');
		return this.prisma.creditTransaction.findMany({
			where: { userId },
			orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
			take: 30,
			...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
		});
	}
	async quote(
		userId: number,
		input: { kind: CreditKind; storyId: number; sceneId?: number; jobId?: number; content?: string }
	) {
		const story = await this.prisma.audioStory.findFirst({
			where: { id: input.storyId, userId },
			include: { scenes: { where: { sceneOrder: { gt: 0 }, ...(input.sceneId ? { id: input.sceneId } : {}) } } }
		});
		if (!story) throw new NotFoundException('Story not found');
		let texts =
			input.kind === 'SINGLE_AUDIO'
				? [(input.content ?? story.content).trim()]
				: story.scenes.map(scene => scene.text);
		if (input.jobId) {
			const job = await this.prisma.audioGenerationJob.findFirst({
				where: { id: input.jobId, storyId: story.id, userId },
				include: { items: { where: { status: 'FAILED' } } }
			});
			if (!job) throw new NotFoundException('Job not found');
			texts = job.items.map(item => item.textSnapshot ?? '');
		}
		if (input.sceneId && !texts.length) throw new NotFoundException('Scene not found');
		await this.prisma.$transaction(tx => this.welcome(tx, userId));
		const user = await this.prisma.user.findUniqueOrThrow({
			where: { id: userId },
			select: { creditBalance: true, creditsBlocked: true }
		});
		const cached =
			input.kind === 'ANALYSIS' &&
			story.analysisStatus === 'COMPLETED' &&
			StoryAnalysisSchema.safeParse(story.analysisResult).success;
		return {
			available: user.creditBalance,
			blocked: user.creditsBlocked,
			credits: cached ? 0 : this.cost(input.kind, texts, await this.pricing()),
			cached,
			characters: texts.reduce((sum, text) => sum + Array.from(text.trim()).length, 0)
		};
	}
}
