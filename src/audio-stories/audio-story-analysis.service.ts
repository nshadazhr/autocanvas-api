import { Injectable } from '@nestjs/common';
import { AiService } from '../ai/ai.service.js';
import { AnalysisSettingsService } from '../settings/analysis-settings.service.js';
import { GeminiAnalysisProvider } from '../ai/analysis/providers/gemini-analysis.provider.js';
import { OpenAIAnalysisProvider } from '../ai/analysis/providers/openai-analysis.provider.js';
import type { AnalysisProvider } from '../ai/analysis/analysis.types.js';
@Injectable()
export class AudioStoryAnalysisService {
	constructor(
		private readonly aiService: AiService,
		private readonly settings: AnalysisSettingsService,
		private readonly gemini: GeminiAnalysisProvider,
		private readonly openai: OpenAIAnalysisProvider
	) {}
	assertEnabled() {
		return this.aiService.assertAnalysisEnabled();
	}
	getModel() {
		return this.aiService.getAnalysisModel();
	}
	getConfiguration() {
		return this.settings.get();
	}
	analyze(
		content: string,
		userId: number,
		model: string,
		provider: AnalysisProvider = 'gemini',
		onRequest?: () => Promise<void>
	) {
		return (provider === 'gemini' ? this.gemini : this.openai).analyze(content, userId, model, onRequest);
	}
}
