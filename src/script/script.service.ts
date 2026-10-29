import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AppSettingsService } from '../settings/app-settings.service.js';
import { OpenAIProvider } from '../ai/providers/openai.provider.js';
@Injectable()
export class ScriptService {
	constructor(
		private readonly settings: AppSettingsService,
		private readonly openai: OpenAIProvider
	) {}
	async generateOutline(title: string, language: string) {
		await this.settings.assertEnabled('scriptEnabled');
		const { values } = await this.settings.section('models');
		const response = await this.openai
			.generateText({
				model: String(values.outlineModel),
				systemPrompt:
					'You are a Hindi moral story outline writer. Return a short story outline in the requested language.',
				userPrompt: `Story Title: ${title}\nLanguage: ${language}`
			})
			.catch(() => {
				throw new ServiceUnavailableException(
					'The script provider could not complete this request. Please try again later.'
				);
			});
		return { title, language, outline: response.text };
	}
}
