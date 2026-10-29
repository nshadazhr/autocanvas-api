import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsISO8601, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
export class AdminAnalysisPerformanceQuery {
	@Type(() => Number) @IsIn([1, 7, 30, 90]) days = 7;
	@IsOptional() @IsIn(['gemini', 'openai']) provider?: 'gemini' | 'openai';
	@IsOptional() @IsString() @Matches(/^[a-z0-9][a-z0-9._-]{0,119}$/) model?: string;
	@Type(() => Number) @IsInt() @Min(1) @Max(10000) page = 1;
	@Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 25;
	@IsOptional() @MaxLength(40) @IsISO8601({ strict: true }) asOf?: string;
}
