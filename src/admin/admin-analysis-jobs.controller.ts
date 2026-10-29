import { AdminAnalysisAttemptsQuery } from './dto/admin-analysis-attempts.dto.js';
import { Controller, Get, Header, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../auth/auth.guard.js';
import { AdminGuard } from '../auth/services/admin.guard.js';
import { AdminAnalysisJobsQuery } from './dto/admin-analysis-jobs.dto.js';
import { AdminAnalysisJobsService } from './admin-analysis-jobs.service.js';
@Controller('admin/analysis-jobs')
@UseGuards(AdminAuthGuard, AdminGuard)
export class AdminAnalysisJobsController {
	constructor(private readonly jobs: AdminAnalysisJobsService) {}
	@Get() @Header('Cache-Control', 'private, no-store') list(@Query() query: AdminAnalysisJobsQuery) {
		return this.jobs.list(query);
	}
	@Get(':id/attempts') @Header('Cache-Control', 'private, no-store') attempts(
		@Param('id', new ParseUUIDPipe()) id: string,
		@Query() query: AdminAnalysisAttemptsQuery
	) {
		return this.jobs.attempts(id, query);
	}

	@Get(':id') @Header('Cache-Control', 'private, no-store') detail(@Param('id', new ParseUUIDPipe()) id: string) {
		return this.jobs.detail(id);
	}
}
