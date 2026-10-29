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
		const client = new OpenAI({
			apiKey: await this.credentials.primary('openai'),
			...(request.jsonSchema ? { maxRetries: 0, timeout: 90000 } : {})
		});
		await request.onRequest?.();
		const response = await client.responses.create({
			model: request.model,
			instructions: request.systemPrompt,
			input: request.userPrompt,
			...(request.jsonSchema && {
				store: false,
				text: {
					format: {
						type: 'json_schema' as const,
						name: 'story_analysis',
						strict: true,
						schema: request.jsonSchema
					}
				}
			}),
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
