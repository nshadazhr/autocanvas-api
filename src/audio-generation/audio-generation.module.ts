import { CreditsModule } from '../credits/credits.module.js';
import { AppSettingsModule } from '../settings/app-settings.module.js';
import { AiUsageModule } from '../ai/usage/ai-usage.module.js';
import { Module } from '@nestjs/common';
import { GeminiTtsService } from './providers/gemini-tts.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AudioGenerationController } from './audio-generation.controller.js';
import { audioGenerationService } from './audio-generation.service.js';
import { SingleVoiceService } from './single-voice.service.js';
import { SingleVoiceController } from './single-voice.controller.js';
import { StorageModule } from '../storage/storage.module.js';

@Module({
	imports: [CreditsModule, AiUsageModule, StorageModule, AppSettingsModule],
	controllers: [AudioGenerationController, SingleVoiceController],
	providers: [GeminiTtsService, audioGenerationService, SingleVoiceService, PrismaService]
})
export class AudioGenerationModule {}
