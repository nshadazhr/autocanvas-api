import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { UserRole } from '../../generated/prisma/client.js';

export class AdminPageQuery {
	@IsOptional() @Type(() => Number) @IsInt() @Min(1) cursor?: number;
	@Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 25;
}
export class AdminUsersQuery extends AdminPageQuery {
	@IsOptional() @IsEnum(UserRole) role?: UserRole;
	@IsOptional() @IsString() @MaxLength(254) search?: string;
}
export class ChangeAdminRoleDto {
	@IsEnum(UserRole) role!: UserRole;
	@IsString() @MinLength(5) @MaxLength(500) reason!: string;
}
