import { Type } from 'class-transformer';
import {
	IsEnum,
	IsInt,
	IsISO8601,
	IsOptional,
	IsString,
	Matches,
	Max,
	MaxLength,
	Min
} from 'class-validator';
import { AudioJobStatus } from '../../generated/prisma/client.js';
import { AdminPageQuery } from '../../auth/dto/admin-role.dto.js';
export class AdminAudioJobsQuery extends AdminPageQuery {
	@IsOptional() @IsEnum(AudioJobStatus) status?: AudioJobStatus;
	@IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(2147483647) userId?: number;
	@IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(2147483647) storyId?: number;
	@IsOptional() @IsString() @MaxLength(120) search?: string;
	@IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsISO8601({ strict: true }) from?: string;
	@IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsISO8601({ strict: true }) to?: string;
}
