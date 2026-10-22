import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { VoicesService } from './voices.service.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { AiService } from '../ai/ai.service.js';

@UseGuards(AuthGuard)
@Controller('voices')
export class VoicesController {
	constructor(
		private readonly voicesService: VoicesService,
		private readonly aiService: AiService
	) {}

	@Get()
	async findAll() {
		return this.voicesService.findAll();
	}

	@Post()
	async syncGeminiVoices() {
		return this.voicesService.importGeminiVoices(this.aiService.getGeminiStudioVoices.bind(this.aiService));
	}
}
