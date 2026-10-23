import { Injectable } from '@nestjs/common';
import { AiService } from '../ai/ai.service.js';
@Injectable()
export class AudioStoryAnalysisService {
	constructor(private readonly aiService: AiService) {}

	async analyze(content: string, userId: number) {
		return this.aiService.analyzeStory(content, userId);
	}
}
