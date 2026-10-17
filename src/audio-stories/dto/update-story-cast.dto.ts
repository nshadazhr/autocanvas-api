import { ArrayMinSize, IsArray, IsInt, IsNotEmpty, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class CastCharacterDto {
	@IsString()
	@IsNotEmpty()
	name: string;

	@IsString()
	@IsNotEmpty()
	gender: string;

	@IsOptional()
	@IsInt()
	@Min(1)
	voiceId?: number | null;
}

export class UpdateStoryCastDto {
	@IsArray()
	@ArrayMinSize(1)
	@ValidateNested({ each: true })
	@Type(() => CastCharacterDto)
	characters: CastCharacterDto[];
}
