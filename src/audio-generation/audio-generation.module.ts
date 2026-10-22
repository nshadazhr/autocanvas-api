import { Module } from '@nestjs/common';
import { GeminiTtsService } from './providers/gemini-tts.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AudioGenerationController } from './audio-generation.controller.js';
import { audioGenerationService } from './audio-generation.service.js';
import { GeminiKeyManagerService } from './providers/gemini-key-manager.service.js';
import { SingleVoiceService } from './single-voice.service.js';
import { SingleVoiceController } from './single-voice.controller.js';
import { StorageModule } from '../storage/storage.module.js';

@Module({
	imports: [StorageModule],
	controllers: [AudioGenerationController, SingleVoiceController],
	providers: [GeminiTtsService, GeminiKeyManagerService, audioGenerationService, SingleVoiceService, PrismaService]
})
export class AudioGenerationModule {}
