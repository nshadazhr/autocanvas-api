import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiController } from './ai.controller.js';
import { AiService } from './ai.service.js';
import { AiPromptService } from './services/ai-prompt.service.js';

@Module({
	imports: [ConfigModule],
	controllers: [AiController],
	providers: [AiService, AiPromptService],
	exports: [AiService, AiPromptService]
})
export class AiModule {}
