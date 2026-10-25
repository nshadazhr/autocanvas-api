import { AppSettingsModule } from '../settings/app-settings.module.js';
import { AiUsageModule } from './usage/ai-usage.module.js';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiController } from './ai.controller.js';
import { AiService } from './ai.service.js';
import { AiPromptService } from './services/ai-prompt.service.js';

@Module({
	imports: [AiUsageModule, ConfigModule, AppSettingsModule],
	controllers: [AiController],
	providers: [AiService, AiPromptService],
	exports: [AiService, AiPromptService]
})
export class AiModule {}
