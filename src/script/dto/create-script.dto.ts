import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class CreateScriptDto {
	@IsString()
	@IsNotEmpty()
	title: string;

	@IsOptional()
	@IsString()
	content?: string;
}
