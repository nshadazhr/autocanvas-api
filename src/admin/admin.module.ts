import { AdminAudioJobsController } from './admin-audio-jobs.controller.js';
import { AdminAudioJobsService } from './admin-audio-jobs.service.js';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AdminDashboardController } from './admin-dashboard.controller.js';
import { AdminDashboardService } from './admin-dashboard.service.js';
@Module({
	imports: [AuthModule],
	controllers: [AdminDashboardController, AdminAudioJobsController],
	providers: [PrismaService, AdminDashboardService, AdminAudioJobsService]
})
export class AdminModule {}
