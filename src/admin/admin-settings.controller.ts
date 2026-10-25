import { Body, Controller, Get, Header, Patch, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../auth/auth.guard.js';
import { SuperAdminGuard } from '../auth/services/superadmin.guard.js';
import { AuthOriginGuard } from '../auth/services/auth-origin.guard.js';
import { AppSettingsService } from '../settings/app-settings.service.js';
import { UpdateAnalysisModelDto } from './dto/analysis-model.dto.js';

@Controller('admin/settings/analysis-model')
@UseGuards(AuthOriginGuard, AdminAuthGuard, SuperAdminGuard)
export class AdminSettingsController {
	constructor(private readonly settings: AppSettingsService) {}
	@Get()
	@Header('Cache-Control', 'private, no-store')
	getModel() {
		return this.settings.analysisModel();
	}

	@Patch()
	@Header('Cache-Control', 'private, no-store')
	setModel(@Body() dto: UpdateAnalysisModelDto) {
		return this.settings.setAnalysisModel(dto.model);
	}
}
