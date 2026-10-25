import { OpenAIProvider } from '../ai/providers/openai.provider.js';
import { AppSettingsModule } from '../settings/app-settings.module.js';
import { Module } from '@nestjs/common';
import { ScriptController } from './script.controller.js';
import { ScriptService } from './script.service.js';

@Module({
	imports: [AppSettingsModule],
	controllers: [ScriptController],
	providers: [ScriptService, OpenAIProvider]
})
export class ScriptModule {}
