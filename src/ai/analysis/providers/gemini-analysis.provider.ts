import { Injectable } from '@nestjs/common';
import { AiService } from '../../ai.service.js';
/** Preserve the existing Gemini schema, prompt and validation implementation. */
@Injectable()
export class GeminiAnalysisProvider {
	constructor(private readonly ai: AiService) {}
	analyze(content: string, userId: number, model: string, onRequest?: () => Promise<void>) {
		return this.ai.analyzeStory(content, userId, model, onRequest);
	}
}
