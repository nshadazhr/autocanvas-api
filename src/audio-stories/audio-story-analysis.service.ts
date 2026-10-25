import { Injectable } from '@nestjs/common';
import { AiService } from '../ai/ai.service.js';
@Injectable()
export class AudioStoryAnalysisService {
	constructor(private readonly aiService: AiService) {}

	assertEnabled() {
		return this.aiService.assertAnalysisEnabled();
	}

	getModel() {
		return this.aiService.getAnalysisModel();
	}

	async analyze(content: string, userId: number, model: string) {
		return this.aiService.analyzeStory(content, userId, model);
	}
}
