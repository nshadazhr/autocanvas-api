import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AdminAnalysisPerformanceQuery } from './dto/admin-analysis-performance.dto.js';
type Metrics = {
	recordedAttempts: number;
	completedAttempts: number;
	successes: number;
	failures: number;
	busyErrors: number;
	rateLimitErrors: number;
	running: number;
	cancelled: number;
	interrupted: number;
	localFailures: number;
	latencySamples: number;
	avgSuccessMs: number | null;
	medianSuccessMs: number | null;
};
const eligible = Prisma.sql`(a.status = 'COMPLETED' OR (a.status = 'FAILED' AND a."errorCategory" IS DISTINCT FROM 'COMMIT_FAILED'))`;
const metrics = Prisma.sql`
 COUNT(*)::int AS "recordedAttempts",
 COUNT(*) FILTER (WHERE ${eligible})::int AS "completedAttempts",
 COUNT(*) FILTER (WHERE a.status='COMPLETED')::int AS successes,
 COUNT(*) FILTER (WHERE a.status='FAILED' AND a."errorCategory" IS DISTINCT FROM 'COMMIT_FAILED')::int AS failures,
 COUNT(*) FILTER (WHERE a.status='FAILED' AND a."errorCategory"='BUSY')::int AS "busyErrors",
 COUNT(*) FILTER (WHERE a.status='FAILED' AND a."errorCategory" IS DISTINCT FROM 'COMMIT_FAILED' AND a."providerHttpStatus"=429)::int AS "rateLimitErrors",
 COUNT(*) FILTER (WHERE a.status='RUNNING')::int AS running,
 COUNT(*) FILTER (WHERE a.status='CANCELLED')::int AS cancelled,
 COUNT(*) FILTER (WHERE a.status='INTERRUPTED')::int AS interrupted,
 COUNT(*) FILTER (WHERE a.status='FAILED' AND a."errorCategory"='COMMIT_FAILED')::int AS "localFailures",
 COUNT(*) FILTER (WHERE a.status='COMPLETED' AND a."durationMs" IS NOT NULL)::int AS "latencySamples",
 AVG(a."durationMs") FILTER (WHERE a.status='COMPLETED')::float8 AS "avgSuccessMs",
 percentile_cont(0.5) WITHIN GROUP (ORDER BY a."durationMs") FILTER (WHERE a.status='COMPLETED')::float8 AS "medianSuccessMs"
`;
function rates<T extends Metrics>(row: T) {
	return {
		...row,
		successRate: row.completedAttempts ? (100 * row.successes) / row.completedAttempts : null,
		busyRate: row.completedAttempts ? (100 * row.busyErrors) / row.completedAttempts : null
	};
}
@Injectable()
export class AdminAnalysisPerformanceService {
	constructor(private readonly prisma: PrismaService) {}
	async overview(query: AdminAnalysisPerformanceQuery) {
		const now = new Date();
		const to = query.asOf ? new Date(query.asOf) : now;
		if (!Number.isFinite(to.getTime()) || to > now)
			throw new BadRequestException('asOf must be a valid timestamp no later than now');
		const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate() - query.days + 1));
		const where = Prisma.sql`a."startedAt">=${from} AND a."startedAt"<=${to} ${query.provider ? Prisma.sql`AND a.provider=${query.provider}` : Prisma.empty} ${query.model ? Prisma.sql`AND a.model=${query.model}` : Prisma.empty}`;
		const scope = {
			startedAt: { gte: from, lte: to },
			...(query.provider ? { provider: query.provider } : {}),
			...(query.model ? { model: query.model } : {})
		};
		return this.prisma.$transaction(
			async tx => {
				const [totals, rows, recentJobs] = await Promise.all([
					tx.$queryRaw<Metrics[]>(Prisma.sql`SELECT ${metrics} FROM "StoryAnalysisAttempt" a WHERE ${where}`),
					tx.$queryRaw<Array<Metrics & { provider: string; model: string }>>(
						Prisma.sql`SELECT a.provider,a.model,${metrics} FROM "StoryAnalysisAttempt" a WHERE ${where} GROUP BY a.provider,a.model ORDER BY a.provider,a.model LIMIT ${query.limit + 1} OFFSET ${(query.page - 1) * query.limit}`
					),
					tx.storyAnalysisJob.findMany({
						where: { attemptHistory: { some: scope } },
						orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
						take: 10,
						select: {
							id: true,
							status: true,
							successfulProvider: true,
							successfulModel: true,
							completedAt: true,
							createdAt: true,
							story: { select: { title: true } }
						}
					})
				]);
				return {
					from: from.toISOString(),
					to: to.toISOString(),
					days: query.days,
					provider: query.provider ?? null,
					model: query.model ?? null,
					totals: rates(totals[0]),
					models: rows.slice(0, query.limit).map(rates),
					page: query.page,
					nextPage: rows.length > query.limit ? query.page + 1 : null,
					recentJobs
				};
			},
			{ isolationLevel: 'RepeatableRead' }
		);
	}
}
