import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { AdminAudioJobsQuery } from './dto/admin-audio-jobs.dto.js';
import { AdminPageQuery } from '../auth/dto/admin-role.dto.js';
import { safeAiError } from '../ai/usage/safe-ai-error.js';
const summary = {
	id: true,
	storyId: true,
	userId: true,
	status: true,
	totalScenes: true,
	completedScenes: true,
	failedScenes: true,
	created_at: true,
	updated_at: true,
	started_at: true,
	completed_at: true,
	story: { select: { title: true } }
} as const;
@Injectable()
export class AdminAudioJobsService {
	constructor(private readonly prisma: PrismaService) {}
	async list(query: AdminAudioJobsQuery) {
		if (query.cursor && query.cursor > 2147483647) throw new BadRequestException('Invalid cursor');
		if (query.from && query.to && query.from > query.to)
			throw new BadRequestException('Start date must not be after end date');
		const search = query.search?.trim();
		const numeric =
			search && /^\d+$/.test(search) && Number.isSafeInteger(Number(search)) && Number(search) <= 2147483647
				? Number(search)
				: undefined;
		const end = query.to ? new Date(query.to + 'T00:00:00.000Z') : undefined;
		if (end) end.setUTCDate(end.getUTCDate() + 1);
		const where: Prisma.AudioGenerationJobWhereInput = {
			...(query.cursor ? { id: { lt: query.cursor } } : {}),
			...(query.status ? { status: query.status } : {}),
			...(query.userId ? { userId: query.userId } : {}),
			...(query.storyId ? { storyId: query.storyId } : {}),
			...(query.from || end
				? {
						created_at: {
							...(query.from ? { gte: new Date(query.from + 'T00:00:00.000Z') } : {}),
							...(end ? { lt: end } : {})
						}
					}
				: {}),
			...(search
				? {
						OR: [
							{ story: { title: { contains: search, mode: 'insensitive' } } },
							...(numeric ? [{ id: numeric }] : [])
						]
					}
				: {})
		};
		const jobs = await this.prisma.audioGenerationJob.findMany({
			where,
			select: summary,
			orderBy: { id: 'desc' },
			take: query.limit + 1
		});
		return {
			jobs: jobs.slice(0, query.limit),
			nextCursor: jobs.length > query.limit ? jobs[query.limit - 1].id : null
		};
	}
	async detail(id: number, query: AdminPageQuery) {
		if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647 || (query.cursor && query.cursor > 2147483647))
			throw new BadRequestException('Invalid job ID or cursor');
		const job = await this.prisma.audioGenerationJob.findUnique({ where: { id }, select: summary });
		if (!job) throw new NotFoundException('Audio generation job not found');
		const items = await this.prisma.audioGenerationJobItem.findMany({
			where: { jobId: id, ...(query.cursor ? { id: { gt: query.cursor } } : {}) },
			orderBy: { id: 'asc' },
			take: query.limit + 1,
			select: {
				id: true,
				sceneId: true,
				status: true,
				attempts: true,
				error: true,
				nextRetryAt: true,
				started_at: true,
				completed_at: true,
				voiceIdSnapshot: true,
				scene: { select: { sceneOrder: true, speakerName: true } },
				audio: { select: { id: true, durationMs: true, format: true } }
			}
		});
		return {
			job,
			items: items
				.slice(0, query.limit)
				.map((item) => ({ ...item, error: item.error ? safeAiError(new Error(item.error)) : null })),
			nextCursor: items.length > query.limit ? items[query.limit - 1].id : null
		};
	}
}
