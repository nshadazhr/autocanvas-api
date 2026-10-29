import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AiUsageService } from './ai-usage.service.js';
import { AppSettingsModule } from '../../settings/app-settings.module.js';

@Module({
	imports: [ConfigModule, AppSettingsModule],
	providers: [PrismaService, AiUsageService],
	exports: [AiUsageService]
})
export class AiUsageModule {}
