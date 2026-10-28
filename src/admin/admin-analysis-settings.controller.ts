import { Body, Controller, Get, Header, Patch, UseGuards } from '@nestjs/common';
import { Allow } from 'class-validator';
import { AdminAuthGuard } from '../auth/auth.guard.js';
import { SuperAdminGuard } from '../auth/services/superadmin.guard.js';
import { AuthOriginGuard } from '../auth/services/auth-origin.guard.js';
import { AnalysisSettingsService } from '../settings/analysis-settings.service.js';
export class AnalysisSettingsDto {
	@Allow() configuration!: unknown;
}
@Controller('admin/settings/analysis')
@UseGuards(AuthOriginGuard, AdminAuthGuard, SuperAdminGuard)
export class AdminAnalysisSettingsController {
	constructor(private readonly settings: AnalysisSettingsService) {}
	@Get() @Header('Cache-Control', 'private, no-store') get() {
		return this.settings.get();
	}
	@Patch() @Header('Cache-Control', 'private, no-store') save(@Body() dto: AnalysisSettingsDto) {
		return this.settings.save(dto.configuration);
	}
}
