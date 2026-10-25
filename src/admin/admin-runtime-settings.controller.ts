import { Body, Controller, Get, Header, Param, Patch, Put, Query, UseGuards } from '@nestjs/common';
import { IsObject, IsIn, IsOptional } from 'class-validator';
import { AdminAuthGuard } from '../auth/auth.guard.js';
import { SuperAdminGuard } from '../auth/services/superadmin.guard.js';
import { AuthOriginGuard } from '../auth/services/auth-origin.guard.js';
import { AppSettingsService } from '../settings/app-settings.service.js';
export class SettingsPatchDto {
	@IsObject() values!: Record<string, unknown>;
	@IsOptional() @IsIn(['en', 'hi']) locale?: string;
}
@Controller('admin/config')
@UseGuards(AuthOriginGuard, AdminAuthGuard, SuperAdminGuard)
export class AdminRuntimeSettingsController {
	constructor(private readonly settings: AppSettingsService) {}
	@Get(':section')
	@Header('Cache-Control', 'private, no-store')
	get(@Param('section') section: string, @Query('locale') locale?: string) {
		return this.settings.section(section, locale);
	}
	@Patch(':section')
	@Header('Cache-Control', 'private, no-store')
	save(@Param('section') section: string, @Body() dto: SettingsPatchDto) {
		return this.settings.updateSection(section, dto.values, dto.locale);
	}
	@Put(':section')
	@Header('Cache-Control', 'private, no-store')
	replace(@Param('section') section: string, @Body() dto: SettingsPatchDto) {
		return this.settings.replaceWebDocument(section, dto.values, dto.locale);
	}
}
