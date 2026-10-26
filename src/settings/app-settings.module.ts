import { ConfigurationSnapshotService } from './configuration-snapshot.service.js';
import { ProviderCredentialsService } from './provider-credentials.service.js';
import { AppConfigController } from './app-config.controller.js';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { AppSettingsService } from './app-settings.service.js';
@Module({
	imports: [ConfigModule],
	controllers: [AppConfigController],
	providers: [ConfigurationSnapshotService, PrismaService, AppSettingsService, ProviderCredentialsService],
	exports: [ConfigurationSnapshotService, AppSettingsService, ProviderCredentialsService]
})
export class AppSettingsModule {}
