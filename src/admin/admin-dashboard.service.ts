import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma, AudioJobStatus } from '../generated/prisma/client.js';

@Injectable()
export class AdminDashboardService {
	constructor(private readonly prisma: PrismaService) {}
	async overview(days: number, includeUsers: boolean) {
		if (days !== 7 && days !== 30) throw new BadRequestException('days must be 7 or 30');
		const now = new Date();
		const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days + 1));
		return this.prisma.$transaction(
			async (tx) => {
				const [users, projects, stories, animations, groups, growth, recentUsers, recentFailedJobs] =
					await Promise.all([
						tx.user.count(),
						tx.project.count(),
						tx.audioStory.count(),
						tx.animationProject.count(),
						tx.audioGenerationJob.groupBy({ by: ['status'], _count: { _all: true } }),
						tx.$queryRaw<Array<{ day: Date; count: bigint }>>(Prisma.sql`
     SELECT date_trunc('day', "created_at") AS day, COUNT(*) AS count
     FROM "User" WHERE "created_at" >= ${start} AND "created_at" <= ${now}
     GROUP BY 1 ORDER BY 1
    `),
						includeUsers
							? tx.user.findMany({
									take: 5,
									orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
									select: { id: true, name: true, email: true, email_verified_at: true, created_at: true }
								})
							: Promise.resolve([]),
						tx.audioGenerationJob.findMany({
							where: { status: { in: ['FAILED', 'PARTIAL'] } },
							take: 5,
							orderBy: [{ updated_at: 'desc' }, { id: 'desc' }],
							select: {
								id: true,
								storyId: true,
								status: true,
								updated_at: true,
								story: { select: { title: true } }
							}
						})
					]);
				const counts = Object.fromEntries(
					Object.values(AudioJobStatus).map((status) => [status, 0])
				) as Record<AudioJobStatus, number>;
				for (const group of groups) counts[group.status] = group._count._all;
				const totalJobs = Object.values(counts).reduce((a, b) => a + b, 0);
				const byDay = new Map(growth.map((row) => [row.day.toISOString().slice(0, 10), Number(row.count)]));
				const userGrowth = Array.from({ length: days }, (_, index) => {
					const date = new Date(start);
					date.setUTCDate(date.getUTCDate() + index);
					const day = date.toISOString().slice(0, 10);
					return { date: day, count: byDay.get(day) || 0 };
				});
				return {
					generatedAt: now.toISOString(),
					range: { days, start: start.toISOString(), end: now.toISOString(), timeZone: 'UTC' },
					totals: {
						users,
						projects: projects + stories + animations,
						audioJobs: totalJobs,
						failedJobs: counts.FAILED + counts.PARTIAL
					},
					projectBreakdown: { projects, audioStories: stories, animationProjects: animations },
					audioJobs: { total: totalJobs, statuses: counts },
					userGrowth,
					canViewUsers: includeUsers,
					recentUsers,
					recentFailedJobs
				};
			},
			{ isolationLevel: 'RepeatableRead', timeout: 15000 }
		);
	}
}
