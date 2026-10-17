import { Module } from '@nestjs/common';
import { GeminiTtsService } from './providers/gemini-tts.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AudioGenerationController } from './audio-generation.controller.js';
import { audioGenerationService } from './audio-generation.service.js';
import { GeminiKeyManagerService } from './providers/gemini-key-manager.service.js';

@Module({
	controllers: [AudioGenerationController],
	providers: [GeminiTtsService, GeminiKeyManagerService, audioGenerationService, PrismaService]
})
export class AudioGenerationModule {}
