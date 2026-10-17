import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreateAnimationSceneDto {
	@IsString()
	@IsNotEmpty()
	@MaxLength(100)
	name: string;

	@IsOptional()
	@IsInt()
	@Min(0)
	sortOrder?: number;

	@IsOptional()
	@IsInt()
	@Min(1)
	durationMs?: number;
}
