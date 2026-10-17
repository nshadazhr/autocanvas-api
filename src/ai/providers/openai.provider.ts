import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

import { AIProvider, AITextRequest, AITextResponse } from './ai-provider.interface.js';

@Injectable()
export class OpenAIProvider implements AIProvider {
	private readonly client: OpenAI;

	constructor(private readonly configService: ConfigService) {
		this.client = new OpenAI({
			apiKey: this.configService.getOrThrow<string>('OPENAI_API_KEY')
		});
	}

	async generateText(request: AITextRequest): Promise<AITextResponse> {
		const response = await this.client.responses.create({
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
