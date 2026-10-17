import { IsInt, IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateAnimationProjectDto {
	@IsString()
	@IsNotEmpty()
	@MaxLength(100)
	name: string;

	@IsInt()
	@IsIn([1280, 1920, 3840])
	width: number;

	@IsInt()
	@IsIn([720, 1080, 2160])
	height: number;

	@IsInt()
	@IsIn([12, 24, 30, 60])
	fps: number;
}
