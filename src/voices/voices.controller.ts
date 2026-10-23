import type { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface.js';
import { Controller, Get, Post, UseGuards, Req } from '@nestjs/common';
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
	async syncGeminiVoices(@Req() req: AuthenticatedRequest) {
		this.aiService.assertDiagnosticsAccess(req.user.id);
		return this.voicesService.importGeminiVoices(() => this.aiService.getGeminiStudioVoices(req.user.id));
	}
}
