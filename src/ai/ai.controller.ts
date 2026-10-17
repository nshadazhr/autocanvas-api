import { Controller, Get, UseGuards } from '@nestjs/common';
import { AiService } from './ai.service.js';
import { AuthGuard } from '../auth/auth.guard.js';

@Controller('ai')
@UseGuards(AuthGuard)
export class AiController {
	constructor(private readonly aiService: AiService) {}

	@Get('test')
	async testGemini() {
		return {
			message: await this.aiService.testGemini()
		};
	}

	@Get('models')
	async listModels() {
		return this.aiService.listModels();
	}
}
