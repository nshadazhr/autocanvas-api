import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { safeAiError } from '../ai/usage/safe-ai-error.js';
import { AdminAnalysisJobsQuery } from './dto/admin-analysis-jobs.dto.js';
const summary = {
	id: true,
	storyId: true,
	userId: true,
	status: true,
	attempts: true,
	nextRetryAt: true,
	errorCode: true,
	errorMessage: true,
	source: true,
	createdAt: true,
	updatedAt: true,
	completedAt: true,
	story: { select: { title: true } }
} as const;
function safe<T extends { errorMessage: string | null }>(job: T): T {
	return { ...job, errorMessage: job.errorMessage ? safeAiError(new Error(job.errorMessage)) : null };
}
@Injectable()
export class AdminAnalysisJobsService {
	constructor(private readonly prisma: PrismaService) {}
	async list(query: AdminAnalysisJobsQuery) {
		if (query.from && query.to && query.from > query.to)
			throw new BadRequestException('Start date must not be after end date');
		const anchor = query.cursor
			? await this.prisma.storyAnalysisJob.findUnique({
					where: { id: query.cursor },
					select: { id: true, createdAt: true }
				})
			: null;
		if (query.cursor && !anchor)
			throw new BadRequestException('Analysis cursor no longer exists. Refresh the list.');
		const search = query.search?.trim();
		const numeric =
			search && /^\d+$/.test(search) && Number(search) > 0 && Number(search) <= 2147483647
				? Number(search)
				: undefined;
		const end = query.to ? new Date(query.to + 'T00:00:00.000Z') : undefined;
		if (end) end.setUTCDate(end.getUTCDate() + 1);
		const where: Prisma.StoryAnalysisJobWhereInput = {
			...(query.status ? { status: query.status } : {}),
			...(query.userId ? { userId: query.userId } : {}),
			...(query.storyId ? { storyId: query.storyId } : {}),
			...(query.from || end
				? {
						createdAt: {
							...(query.from ? { gte: new Date(query.from + 'T00:00:00.000Z') } : {}),
							...(end ? { lt: end } : {})
						}
					}
				: {}),
			AND: [
				...(anchor
					? [
							{
								OR: [
									{ createdAt: { lt: anchor.createdAt } },
									{ createdAt: anchor.createdAt, id: { lt: anchor.id } }
								]
							}
						]
					: []),
				...(search
					? [
							{
								OR: [
									{ id: { contains: search, mode: 'insensitive' as const } },
									{ story: { title: { contains: search, mode: 'insensitive' as const } } },
									...(numeric ? [{ storyId: numeric }, { userId: numeric }] : [])
								]
							}
						]
					: [])
			]
		};
		const jobs = await this.prisma.storyAnalysisJob.findMany({
			where,
			select: summary,
			orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
			take: query.limit + 1
		});
		return {
			jobs: jobs.slice(0, query.limit).map(safe),
			nextCursor: jobs.length > query.limit ? jobs[query.limit - 1].id : null
		};
	}
	async detail(id: string) {
		const job = await this.prisma.storyAnalysisJob.findUnique({
			where: { id },
			select: {
				...summary,
				contentSnapshot: true,
				contentHash: true,
				story: {
					select: { title: true, content: true, analysisStatus: true, analysisResult: true, analyzedAt: true }
				}
			}
		});
		if (!job) throw new NotFoundException('Analysis job not found');
		const { story, ...metadata } = job;
		return {
			job: safe({ ...metadata, story: { title: story.title } }),
			currentStoryAnalysis: {
				status: story.analysisStatus,
				analyzedAt: story.analyzedAt,
				contentMatchesJob: createHash('sha256').update(story.content).digest('hex') === job.contentHash,
				result: story.analysisResult
			}
		};
	}
}
