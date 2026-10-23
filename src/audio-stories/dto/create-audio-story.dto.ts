import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateAudioStoryDto {
	@IsString()
	@IsNotEmpty()
	@MaxLength(120)
	title: string;

	@IsString()
	@IsNotEmpty()
	@MaxLength(30000)
	content: string;
}
