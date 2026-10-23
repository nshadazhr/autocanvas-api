import { ConflictException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';

export const ACTIVE_JOB_STATUSES = ['PENDING', 'PROCESSING', 'WAITING'] as const;

// A transaction-scoped PostgreSQL lock serializes all mutations for one story,
// including requests arriving at different API instances. No schema migration.
export function withStoryLock<T>(
	prisma: PrismaService,
	storyId: number,
	action: (tx: Prisma.TransactionClient) => Promise<T>
) {
	return prisma.$transaction(
		async tx => {
			await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(73124, ${storyId})`;
			return action(tx);
		},
		{ maxWait: 10_000, timeout: 15_000 }
	);
}

export async function assertNoActiveJob(tx: Prisma.TransactionClient, storyId: number) {
	const active = await tx.audioGenerationJob.findFirst({
		where: { storyId, status: { in: [...ACTIVE_JOB_STATUSES] } },
		select: { id: true }
	});
	if (active)
		throw new ConflictException({
			code: 'GENERATION_ALREADY_RUNNING',
			message: 'Audio generation is already running for this story.',
			jobId: active.id
		});
}
