import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Min, Max } from 'class-validator';
export class AdminAnalysisAttemptsQuery {
	@IsOptional() @IsUUID() cursor?: string;
	@Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 25;
}
