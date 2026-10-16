import { IsNotEmpty, IsString } from 'class-validator';

export class CreateAudioStoryDto {
	@IsString()
	@IsNotEmpty()
	title: string;

	@IsString()
	@IsNotEmpty()
	content: string;
}
