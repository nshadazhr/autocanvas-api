import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { OpenAIProvider } from '../../providers/openai.provider.js';
import { AiPromptService } from '../../services/ai-prompt.service.js';
import { AiUsageService } from '../../usage/ai-usage.service.js';
import { StoryAnalysisSchema } from '../../schemas/story-analysis.schema.js';
@Injectable()
export class OpenAIAnalysisProvider {
	constructor(
		private readonly client: OpenAIProvider,
		private readonly prompts: AiPromptService,
		private readonly usage: AiUsageService
	) {}
	async analyze(content: string, userId: number, model: string, onRequest?: () => Promise<void>) {
		const { $schema: _, ...schema } = z.toJSONSchema(StoryAnalysisSchema);
		const systemPrompt = await this.prompts.getPrompt('story-analysis');
		const result = await this.usage.execute(userId, 'analysis', content.length, () =>
			this.client.generateText({
				model,
				systemPrompt,
				userPrompt: content,
				maxOutputTokens: 16384,
				jsonSchema: schema,
				onRequest
			})
		);
		try {
			return StoryAnalysisSchema.parse(JSON.parse(result.text));
		} catch {
			throw Object.assign(new Error('AI returned invalid analysis data'), { code: 'INVALID_ANALYSIS_RESPONSE' });
		}
	}
}
