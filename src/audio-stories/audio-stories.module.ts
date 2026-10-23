import { AiUsageModule } from '../ai/usage/ai-usage.module.js';
import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { AudioStoriesController } from './audio-stories.controller.js';
import { AudioStoriesService } from './audio-stories.service.js';
import { AudioStoryAnalysisService } from './audio-story-analysis.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StoryParserService } from './services/story-parser.service.js';
import { StoryAnalysisValidatorService } from './services/story-analysis-validator.service.js';

@Module({
	imports: [AiUsageModule, AiModule],
	controllers: [AudioStoriesController],
	providers: [
		AudioStoriesService,
		AudioStoryAnalysisService,
		StoryParserService,
		PrismaService,
		StoryAnalysisValidatorService
	]
})
export class AudioStoriesModule {}
