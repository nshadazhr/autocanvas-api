import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { ScriptService } from './script.service.js';

@Controller('script')
export class ScriptController {
	constructor(private readonly scriptService: ScriptService) {}

	@UseGuards(AuthGuard)
	@Post('outline/generate')
	generateOutline(@Body() body: { title: string; language: string }) {
		return this.scriptService.generateOutline(body.title, body.language);
	}
}
