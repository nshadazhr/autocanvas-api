import { GeminiAnalysisProvider } from './analysis/providers/gemini-analysis.provider.js';
import { OpenAIAnalysisProvider } from './analysis/providers/openai-analysis.provider.js';
import { OpenAIProvider } from './providers/openai.provider.js';
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
	providers: [GeminiAnalysisProvider, OpenAIAnalysisProvider, OpenAIProvider, AiService, AiPromptService],
	exports: [GeminiAnalysisProvider, OpenAIAnalysisProvider, AiService, AiPromptService]
})
export class AiModule {}
