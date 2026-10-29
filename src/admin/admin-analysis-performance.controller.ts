import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../auth/auth.guard.js';
import { AdminGuard } from '../auth/services/admin.guard.js';
import { AdminAnalysisPerformanceService } from './admin-analysis-performance.service.js';
import { AdminAnalysisPerformanceQuery } from './dto/admin-analysis-performance.dto.js';
@Controller('admin/analysis-performance')
@UseGuards(AdminAuthGuard, AdminGuard)
export class AdminAnalysisPerformanceController {
	constructor(private readonly performance: AdminAnalysisPerformanceService) {}
	@Get() @Header('Cache-Control', 'private, no-store') get(@Query() query: AdminAnalysisPerformanceQuery) {
		return this.performance.overview(query);
	}
}
