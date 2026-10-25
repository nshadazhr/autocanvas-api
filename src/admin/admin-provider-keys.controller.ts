import { Body, Controller, Delete, Get, Header, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsString, Length, Matches } from 'class-validator';
import { AdminAuthGuard } from '../auth/auth.guard.js';
import { SuperAdminGuard } from '../auth/services/superadmin.guard.js';
import { AuthOriginGuard } from '../auth/services/auth-origin.guard.js';
import { ProviderCredentialsService } from '../settings/provider-credentials.service.js';
export class AddProviderKeyDto {
	@IsString() @Length(1, 80) name!: string;
	@IsString() @Length(8, 4096) @Matches(/^\S+$/) key!: string;
}
export class ChangeProviderKeyDto {
	@IsBoolean() enabled!: boolean;
}
@Controller('admin/provider-keys/:provider')
@UseGuards(AuthOriginGuard, AdminAuthGuard, SuperAdminGuard)
export class AdminProviderKeysController {
	constructor(private readonly keys: ProviderCredentialsService) {}
	@Get() @Header('Cache-Control', 'private, no-store') list(@Param('provider') provider: string) {
		return this.keys.list(provider);
	}
	@Post() @Header('Cache-Control', 'private, no-store') add(
		@Param('provider') provider: string,
		@Body() dto: AddProviderKeyDto
	) {
		return this.keys.add(provider, dto.name, dto.key);
	}
	@Post('import-environment') @Header('Cache-Control', 'private, no-store') import(
		@Param('provider') provider: string
	) {
		return this.keys.importEnvironment(provider);
	}
	@Post('use-environment') @Header('Cache-Control', 'private, no-store') environment(
		@Param('provider') provider: string
	) {
		return this.keys.useEnvironment(provider);
	}
	@Patch(':id') @Header('Cache-Control', 'private, no-store') change(
		@Param('provider') provider: string,
		@Param('id') id: string,
		@Body() dto: ChangeProviderKeyDto
	) {
		return this.keys.change(provider, id, dto.enabled);
	}
	@Delete(':id') @Header('Cache-Control', 'private, no-store') remove(
		@Param('provider') provider: string,
		@Param('id') id: string
	) {
		return this.keys.remove(provider, id);
	}
}
