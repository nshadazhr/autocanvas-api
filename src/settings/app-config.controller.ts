import { Controller, Get, Header, Query } from '@nestjs/common';
import { AppSettingsService } from './app-settings.service.js';

@Controller('app-config')
export class AppConfigController {
	constructor(private readonly settings: AppSettingsService) {}

	@Get()
	@Header('Cache-Control', 'no-store')
	get(@Query('locale') locale?: string) {
		return this.settings.appConfig(locale);
	}
}
