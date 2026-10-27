import { AdminAnalysisJobsController } from './admin-analysis-jobs.controller.js';
import { AdminAnalysisJobsService } from './admin-analysis-jobs.service.js';
import { AdminCreditsController } from './admin-credits.controller.js';
import { CreditsModule } from '../credits/credits.module.js';
import { AdminRuntimeSettingsController } from './admin-runtime-settings.controller.js';
import { AdminProviderKeysController } from './admin-provider-keys.controller.js';
import { AppSettingsModule } from '../settings/app-settings.module.js';
import { AdminSettingsController } from './admin-settings.controller.js';
import { AdminAudioJobsController } from './admin-audio-jobs.controller.js';
import { AdminAudioJobsService } from './admin-audio-jobs.service.js';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AdminDashboardController } from './admin-dashboard.controller.js';
import { AdminDashboardService } from './admin-dashboard.service.js';
@Module({
	imports: [CreditsModule, AuthModule, AppSettingsModule],
	controllers: [
		AdminAnalysisJobsController,
		AdminCreditsController,
		AdminDashboardController,
		AdminAudioJobsController,
		AdminSettingsController,
		AdminRuntimeSettingsController,
		AdminProviderKeysController
	],
	providers: [AdminAnalysisJobsService, PrismaService, AdminDashboardService, AdminAudioJobsService]
})
export class AdminModule {}
