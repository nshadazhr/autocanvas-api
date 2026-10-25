import { ProviderCredentialsService } from '../../settings/provider-credentials.service.js';
import { AppSettingsService } from '../../settings/app-settings.service.js';
import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';

import { AIProvider, AITextRequest, AITextResponse } from './ai-provider.interface.js';

@Injectable()
export class OpenAIProvider implements AIProvider {
	constructor(
		private readonly credentials: ProviderCredentialsService,
		private readonly settings: AppSettingsService
	) {}

	async generateText(request: AITextRequest): Promise<AITextResponse> {
		await this.settings.assertEnabled('openaiEnabled');
		const client = new OpenAI({ apiKey: await this.credentials.primary('openai') });
		const response = await client.responses.create({
			model: request.model,
			instructions: request.systemPrompt,
			input: request.userPrompt,
			...(request.temperature !== undefined && {
				temperature: request.temperature
			}),
			...(request.maxOutputTokens !== undefined && {
				max_output_tokens: request.maxOutputTokens
			})
		});

		return {
			provider: 'openai',
			model: response.model,
			text: response.output_text,
			usage: response.usage
				? {
						inputTokens: response.usage.input_tokens,
						outputTokens: response.usage.output_tokens
					}
				: undefined
		};
	}
}
