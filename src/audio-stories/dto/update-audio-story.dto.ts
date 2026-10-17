import { PartialType } from '@nestjs/swagger';
import { CreateAudioStoryDto } from './create-audio-story.dto.js';

export class UpdateAudioStoryDto extends PartialType(CreateAudioStoryDto) {}
