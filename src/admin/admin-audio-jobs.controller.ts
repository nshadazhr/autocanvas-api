import { Controller, Get, Header, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../auth/auth.guard.js';
import { AdminGuard } from '../auth/services/admin.guard.js';
import { AdminPageQuery } from '../auth/dto/admin-role.dto.js';
import { AdminAudioJobsQuery } from './dto/admin-audio-jobs.dto.js';
import { AdminAudioJobsService } from './admin-audio-jobs.service.js';
@Controller('admin/audio-jobs')
@UseGuards(AdminAuthGuard, AdminGuard)
export class AdminAudioJobsController {
	constructor(private readonly jobs: AdminAudioJobsService) {}
	@Get() @Header('Cache-Control', 'private, no-store') list(@Query() query: AdminAudioJobsQuery) {
		return this.jobs.list(query);
	}
	@Get(':id') @Header('Cache-Control', 'private, no-store') detail(
		@Param('id', ParseIntPipe) id: number,
		@Query() query: AdminPageQuery
	) {
		return this.jobs.detail(id, query);
	}
}
