import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AiCapacityError } from './ai-capacity.error.js';
import { AppSettingsService } from '../../settings/app-settings.service.js';

@Injectable()
export class AiUsageService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly config: ConfigService,
		private readonly settings: AppSettingsService
	) {}

	limit(name: string, fallback: number) {
		const value = Number(this.config.get<string>(name));
		return Number.isSafeInteger(value) && value > 0 ? value : fallback;
	}

	private async consume(
		tx: Prisma.TransactionClient,
		rules: { scope: string; window: number; maxRequests: number; maxUnits: number }[],
		units: number
	) {
		const now = Date.now();
		const buckets = rules.map(rule => {
			const start = Math.floor(now / rule.window) * rule.window;
			return { ...rule, key: `${rule.scope}:${rule.window}:${start}`, expiresAt: new Date(start + rule.window) };
		});
		const current = await tx.aiUsageBucket.findMany({ where: { key: { in: buckets.map(bucket => bucket.key) } } });
		const blocked = buckets.filter(bucket => {
			const value = current.find(value => value.key === bucket.key);
			return (value?.requests ?? 0) + 1 > bucket.maxRequests || (value?.units ?? 0) + units > bucket.maxUnits;
		});
		if (blocked.length)
			throw new AiCapacityError(new Date(Math.max(...blocked.map(bucket => bucket.expiresAt.getTime()))));
		for (const bucket of buckets)
			await tx.aiUsageBucket.upsert({
				where: { key: bucket.key },
				create: { key: bucket.key, requests: 1, units, expiresAt: bucket.expiresAt },
				update: { requests: { increment: 1 }, units: { increment: units } }
			});
	}

	async execute<T>(userId: number, kind: string, units: number, action: () => Promise<T>): Promise<T> {
		if (!Number.isSafeInteger(userId) || userId <= 0)
			throw new BadRequestException('An authenticated user is required for AI requests');
		if (!Number.isSafeInteger(units) || units < 0 || units > this.limit('AI_MAX_REQUEST_CHARACTERS', 40_000))
			throw new BadRequestException('AI request is too large');
		// Analysis has no application request/day/character budgets or AI concurrency caps.
		// Authentication and request-size validation above still apply.
		if (kind === 'analysis') return action();
		const { values } = await this.settings.section('processing');
		const quotas = {
			globalRequestsPerMinute: Number(values.globalRequestsPerMinute),
			globalRequestsPerDay: Number(values.globalRequestsPerDay),
			userRequestsPerMinute: Number(values.userRequestsPerMinute),
			userRequestsPerDay: Number(values.userRequestsPerDay),
			globalCharactersPerDay: Number(values.globalCharactersPerDay),
			userCharactersPerDay: Number(values.userCharactersPerDay)
		};
		if (
			Object.entries(quotas).some(
				([key, value]) =>
					!Number.isSafeInteger(value) ||
					value < 1 ||
					value > (key.endsWith('CharactersPerDay') ? 1000000000 : 1000000)
			)
		)
			throw new BadRequestException('AI usage settings are invalid');
		const leaseId = randomUUID();
		await this.prisma.$transaction(
			async tx => {
				await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(73125, 0)`;
				const now = new Date();
				await tx.aiRequestLease.deleteMany({ where: { expiresAt: { lte: now } } });
				const [globalCount, userCount] = await Promise.all([
					tx.aiRequestLease.count(),
					tx.aiRequestLease.count({ where: { userId } })
				]);
				if (
					globalCount >= this.limit('AI_GLOBAL_CONCURRENCY', 3) ||
					userCount >= this.limit('AI_USER_CONCURRENCY', 1)
				)
					throw new AiCapacityError(
						new Date(Date.now() + 15_000),
						'AI is busy. Your job will retry automatically.'
					);
				await this.consume(
					tx,
					[
						{
							scope: 'provider:global',
							window: 60_000,
							maxRequests: quotas.globalRequestsPerMinute,
							maxUnits: Number.MAX_SAFE_INTEGER
						},
						{
							scope: 'provider:global',
							window: 86_400_000,
							maxRequests: quotas.globalRequestsPerDay,
							maxUnits: quotas.globalCharactersPerDay
						},
						{
							scope: `provider:user:${userId}`,
							window: 60_000,
							maxRequests: quotas.userRequestsPerMinute,
							maxUnits: Number.MAX_SAFE_INTEGER
						},
						{
							scope: `provider:user:${userId}`,
							window: 86_400_000,
							maxRequests: quotas.userRequestsPerDay,
							maxUnits: quotas.userCharactersPerDay
						}
					],
					units
				);
				await tx.aiRequestLease.create({
					data: { id: leaseId, userId, kind, expiresAt: new Date(Date.now() + 120_000) }
				});
				await tx.aiUsageBucket.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 86_400_000) } } });
			},
			{ timeout: 15_000, maxWait: 10_000 }
		);
		try {
			return await action();
		} finally {
			await this.prisma.aiRequestLease.deleteMany({ where: { id: leaseId } }).catch(() => undefined);
		}
	}
}
