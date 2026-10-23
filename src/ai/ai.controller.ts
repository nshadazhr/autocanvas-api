import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AiService } from './ai.service.js';
import { AuthGuard } from '../auth/auth.guard.js';
import type { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface.js';

@Controller('ai')
@UseGuards(AuthGuard)
export class AiController {
	constructor(private readonly aiService: AiService) {}

	@Get('test')
	async testGemini(@Req() req: AuthenticatedRequest) {
		return {
			message: await this.aiService.testGemini(req.user.id)
		};
	}

	@Get('models')
	async listModels(@Req() req: AuthenticatedRequest) {
		return this.aiService.listModels(req.user.id);
	}
}
