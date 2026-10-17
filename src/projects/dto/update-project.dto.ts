import { IsOptional, IsString, IsNotEmpty } from 'class-validator';

export class UpdateProjectDto {
	@IsOptional()
	@IsString()
	@IsNotEmpty()
	name?: string;

	@IsOptional()
	@IsString()
	description?: string;
}
