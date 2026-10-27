import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { StoryAnalysisJobStatus } from '../../generated/prisma/client.js';

export class AdminAnalysisJobsQuery {
	@IsOptional()
	@IsUUID()
	cursor?: string;

	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(100)
	limit = 25;

	@IsOptional()
	@IsEnum(StoryAnalysisJobStatus)
	status?: StoryAnalysisJobStatus;

	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(2147483647)
	userId?: number;

	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(2147483647)
	storyId?: number;

	@IsOptional()
	@IsString()
	@MaxLength(120)
	search?: string;

	@IsOptional()
	@Matches(/^\d{4}-\d{2}-\d{2}$/)
	@IsISO8601({ strict: true })
	from?: string;

	@IsOptional()
	@Matches(/^\d{4}-\d{2}-\d{2}$/)
	@IsISO8601({ strict: true })
	to?: string;
}
